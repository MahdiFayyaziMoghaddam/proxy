"use server";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const STRIP_REQ = new Set([
	"host",
	"origin",
	"referer",
	"content-length",
	"connection",
	"accept-encoding",
	"cookie",
	"sec-fetch-dest",
	"sec-fetch-mode",
	"sec-fetch-site",
	"sec-fetch-user"
]);

const STRIP_RES = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"set-cookie",
	"content-security-policy",
	"content-security-policy-report-only",
	"x-frame-options"
]);

function parse(url: string): URL | null {
	try {
		return new URL(url.startsWith("http") ? url : `https://${url}`);
	} catch {
		return null;
	}
}

// crude SSRF guard — good enough for a toy
function isSafe(u: URL): boolean {
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	const h = u.hostname.toLowerCase();
	if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
	if (
		/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ||
		h === "::1" ||
		h.startsWith("fc") ||
		h.startsWith("fd") ||
		h.startsWith("fe80")
	) {
		return false;
	}
	return true;
}

// turn an absolute URL into /__asset/<proto>/<host>/<path...>
function toAssetUrl(absUrl: string): string {
	const u = new URL(absUrl);
	const proto = u.protocol.replace(":", "");
	const path = u.pathname.replace(/^\/+/, "");
	const q = u.search ? u.search : "";
	return `/__asset/${proto}/${u.host}/${path}${q}`;
}

// turn a relative path into an absolute URL, guarded
function abs(path: string, base: string): string {
	try {
		return new URL(path, base).href;
	} catch {
		return path;
	}
}

// ============================================================
// initial page load
// ============================================================
export async function request(rawUrl: string) {
	const u = parse(rawUrl);
	if (!u || !isSafe(u)) return "Invalid URL";

	let res: Response;
	try {
		res = await fetch(u, {
			headers: { "user-agent": UA },
			redirect: "follow"
		});
	} catch {
		return "Failed to fetch";
	}

	const base = res.url || u.href;
	let html = await res.text();

	// ---- extract external assets ----
	const scriptUrls = [...new Set([...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => abs(m[1], base)))];

	const styleUrls = [
		...new Set(
			[...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].map((m) => abs(m[1], base))
		)
	];

	// ---- extract head bits ----
	const head = [...(html.match(/<title[^>]*>[\s\S]*?<\/title>/gi) ?? []), ...(html.match(/<meta[^>]*>/gi) ?? [])].join(
		"\n"
	);

	// ---- strip what we hoisted ----
	html = html
		.replace(/<script[^>]+src=["'][^"']+["'][^>]*>\s*<\/script>/gi, "")
		.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, "")
		.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, "")
		.replace(/<meta[^>]*>/gi, "");

	// ---- rewrite remaining relative urls ----
	html = html.replace(
		/(href|src|srcset|action|poster|data-src)=["'](?!https?:\/\/|\/\/|data:|#|javascript:)([^"']+)["']/gi,
		(_, attr: string, value: string) => {
			try {
				if (attr.toLowerCase() === "srcset") {
					const out = value
						.split(",")
						.map((part) => {
							const [p, size] = part.trim().split(/\s+/);
							return `${abs(p, base)}${size ? " " + size : ""}`;
						})
						.join(", ");
					return `srcset="${out}"`;
				}
				return `${attr}="${abs(value, base)}"`;
			} catch {
				return `${attr}="${value}"`;
			}
		}
	);

	// ---- fetch + rewrite CSS ----
	const styles = (
		await Promise.all(
			styleUrls.map(async (href) => {
				try {
					const css = await (await fetch(href, { headers: { "user-agent": UA } })).text();
					// rewrite url(...) refs to absolute
					return css.replace(
						/url\(\s*(['"]?)(?!data:|https?:|\/\/)([^)'"]+)\1\s*\)/g,
						(_, q: string, p: string) => `url(${q}${abs(p, href)}${q})`
					);
				} catch {
					return "";
				}
			})
		)
	)
		.filter(Boolean)
		.join("\n");

	// ---- ship script URLs already routed through /__asset ----
	const proxiedScripts = scriptUrls.map(toAssetUrl);

	return { head, body: html, styles, scriptUrls: proxiedScripts, baseUrl: base };
}

// ============================================================
// generic fetch / xhr proxy
// ============================================================
export async function proxyRequest(input: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}) {
	const u = parse(input.url);
	if (!u || !isSafe(u)) {
		return { status: 400, headers: {}, body: "Invalid URL" };
	}

	const headers: Record<string, string> = { "user-agent": UA };
	for (const [k, v] of Object.entries(input.headers ?? {})) {
		const lk = k.toLowerCase();
		if (!STRIP_REQ.has(lk)) headers[lk] = v;
	}

	const method = (input.method ?? "GET").toUpperCase();
	const hasBody = !["GET", "HEAD"].includes(method);

	try {
		const res = await fetch(u, {
			method,
			headers,
			body: hasBody ? input.body : undefined,
			redirect: "follow"
		});

		const body = await res.text();
		const resHeaders: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			if (!STRIP_RES.has(k.toLowerCase())) resHeaders[k] = v;
		});

		return { status: res.status, headers: resHeaders, body, finalUrl: res.url };
	} catch {
		return { status: 502, headers: {}, body: "Proxy failed", finalUrl: input.url };
	}
}
