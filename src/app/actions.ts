"use server";

const FAKE_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Accept-Encoding": "gzip, deflate, br",
	"Cache-Control": "no-cache",
	Pragma: "no-cache",
	"Sec-Ch-Ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
	"Sec-Ch-Ua-Mobile": "?0",
	"Sec-Ch-Ua-Platform": '"Windows"',
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1"
};

function isValidUrl(url: string) {
	try {
		new URL(url.startsWith("http") ? url : `https://${url}`);
		return true;
	} catch {
		return false;
	}
}

function abs(url: string, base: string) {
	try {
		return new URL(url, base).href;
	} catch {
		return url;
	}
}

// ---------- initial page load ----------
export async function request(data: FormData) {
	const raw = data.get("url");
	if (typeof raw !== "string" || !isValidUrl(raw)) return "Invalid URL";

	const baseUrl = raw.startsWith("http") ? raw : `https://${raw}`;

	try {
		const res = await fetch(baseUrl, {
			headers: FAKE_HEADERS,
			redirect: "follow"
		});

		let html = await res.text();

		// collect external assets
		const scriptUrls = [
			...new Set([...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => abs(m[1], baseUrl)))
		].filter(Boolean) as string[];

		const linkUrls = [
			...new Set(
				[...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].map((m) =>
					abs(m[1], baseUrl)
				)
			)
		].filter(Boolean) as string[];

		const headParts = [
			...(html.match(/<title[^>]*>[\s\S]*?<\/title>/gi) || []),
			...(html.match(/<meta[^>]*>/gi) || [])
		].join("\n");

		// strip external scripts + styles from html
		html = html
			.replace(/<script[^>]+src=["'][^"']+["'][^>]*>\s*<\/script>/gi, "")
			.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, "")
			.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, "")
			.replace(/<meta[^>]*>/gi, "");

		// make remaining relative urls absolute
		html = html.replace(
			/(href|src|srcset)=["'](?!https?:\/\/|\/\/|data:|#|javascript:)([^"']+)["']/gi,
			(_, attr, path) => {
				try {
					if (attr === "srcset") {
						const parts = path.split(",").map((p: string) => {
							const [u, size] = p.trim().split(/\s+/);
							return `${abs(u, baseUrl)}${size ? " " + size : ""}`;
						});
						return `srcset="${parts.join(", ")}"`;
					}
					return `${attr}="${abs(path, baseUrl)}"`;
				} catch {
					return `${attr}="${path}"`;
				}
			}
		);

		// fetch css + js
		const [styles, scripts] = await Promise.all([
			Promise.all(
				linkUrls.map(async (href) => {
					try {
						const r = await fetch(href, { headers: FAKE_HEADERS });
						return await r.text();
					} catch {
						return "";
					}
				})
			),
			Promise.all(
				scriptUrls.map(async (src) => {
					try {
						const r = await fetch(src, { headers: FAKE_HEADERS });
						return await r.text();
					} catch {
						return "";
					}
				})
			)
		]);

		return {
			head: headParts,
			body: html,
			styles: styles.filter(Boolean),
			scripts: scripts.filter(Boolean),
			baseUrl
		};
	} catch {
		return "Failed to fetch";
	}
}

// ---------- generic proxy for fetch / xhr ----------
export async function proxyRequest(data: FormData) {
	const url = data.get("url") as string;
	const method = (data.get("method") as string) || "GET";
	const headersJson = data.get("headers") as string;
	const body = data.get("body") as string | null;

	if (!url || !isValidUrl(url)) {
		return { status: 400, headers: {}, body: "Invalid URL" };
	}

	let headers: Record<string, string> = { ...FAKE_HEADERS };
	try {
		if (headersJson) {
			const extra = JSON.parse(headersJson);
			headers = { ...headers, ...extra };
		}
	} catch {}

	// never forward host / origin / referer from client
	delete headers["host"];
	delete headers["origin"];
	delete headers["referer"];

	try {
		const res = await fetch(url, {
			method,
			headers,
			body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
			redirect: "follow"
		});

		const text = await res.text();
		const resHeaders: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			// skip hop-by-hop
			if (!["content-encoding", "transfer-encoding", "connection"].includes(k.toLowerCase())) {
				resHeaders[k] = v;
			}
		});

		return {
			status: res.status,
			headers: resHeaders,
			body: text
		};
	} catch (e) {
		return {
			status: 502,
			headers: {},
			body: "Proxy failed"
		};
	}
}
