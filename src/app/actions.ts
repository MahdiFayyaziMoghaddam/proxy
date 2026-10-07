"use server";

const FAKE_HEADERS: HeadersInit = {
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

const URL_REGEX = /^(https?:\/\/)?([\w-]+\.)+[\w-]+(\/[\w\-./?%&=+#]*)?$/i;

function isValidUrl(url: string): boolean {
	if (typeof url !== "string" || !URL_REGEX.test(url)) return false;
	try {
		new URL(url.startsWith("http") ? url : `https://${url}`);
		return true;
	} catch {
		return false;
	}
}

function toAbsolute(url: string, base: string): string {
	try {
		if (
			url.startsWith("http") ||
			url.startsWith("//") ||
			url.startsWith("data:") ||
			url.startsWith("#") ||
			url.startsWith("javascript:")
		) {
			return url.startsWith("//") ? `https:${url}` : url;
		}
		return new URL(url, base).href;
	} catch {
		return url;
	}
}

/** Rewrite every relative/absolute URL that appears in CSS or JS text so it goes through the proxy later */
function rewriteUrlsInText(text: string, baseUrl: string): string {
	// CSS url(...) and JS string literals that look like URLs
	return text
		.replace(
			/url\(\s*(['"]?)(?!https?:\/\/|\/\/|data:|#|javascript:)([^'")]+)\1\s*\)/gi,
			(_, quote, path) => `url(${quote}${toAbsolute(path, baseUrl)}${quote})`
		)
		.replace(/(["'`])(?!https?:\/\/|\/\/|data:|#|javascript:)(\/?[\w\-./?%&=+#]+)\1/gi, (match, quote, path) => {
			// only rewrite if it looks like a path
			if (path.includes(".") || path.startsWith("/") || path.startsWith("./") || path.startsWith("../")) {
				try {
					return `${quote}${toAbsolute(path, baseUrl)}${quote}`;
				} catch {
					return match;
				}
			}
			return match;
		});
}

export async function request(data: FormData) {
	const raw = data.get("url");
	if (typeof raw !== "string" || !isValidUrl(raw)) {
		return { error: "Invalid URL" };
	}

	const baseUrl = raw.startsWith("http") ? raw : `https://${raw}`;

	try {
		const res = await fetch(baseUrl, {
			headers: FAKE_HEADERS,
			redirect: "follow"
		});

		if (!res.ok) {
			return { error: `Upstream returned ${res.status}` };
		}

		let html = await res.text();

		// Collect external scripts
		const scriptUrls = [
			...new Set(
				[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => {
					try {
						return toAbsolute(m[1], baseUrl);
					} catch {
						return null;
					}
				})
			)
		].filter(Boolean) as string[];

		// Collect stylesheets
		const linkUrls = [
			...new Set(
				[...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].map((m) => {
					try {
						return toAbsolute(m[1], baseUrl);
					} catch {
						return null;
					}
				})
			)
		].filter(Boolean) as string[];

		// Keep useful head pieces
		const headParts = [
			...(html.match(/<title[^>]*>[\s\S]*?<\/title>/gi) || []),
			...(html.match(/<meta[^>]*>/gi) || []),
			...(html.match(/<link[^>]+rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*>/gi) || [])
		].join("\n");

		// Strip external scripts + stylesheets + title/meta so we control them
		html = html
			.replace(/<script[^>]+src=["'][^"']+["'][^>]*>\s*<\/script>/gi, "")
			.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, "")
			.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, "")
			.replace(/<meta[^>]*>/gi, "");

		// Make every remaining href/src/srcset absolute
		html = html.replace(
			/(href|src|srcset)=["'](?!https?:\/\/|\/\/|data:|#|javascript:)([^"']+)["']/gi,
			(_, attr, path) => {
				try {
					if (attr === "srcset") {
						const parts = path.split(",").map((p: string) => {
							const [urlPart, size] = p.trim().split(/\s+/);
							return `${toAbsolute(urlPart, baseUrl)}${size ? " " + size : ""}`;
						});
						return `srcset="${parts.join(", ")}"`;
					}
					return `${attr}="${toAbsolute(path, baseUrl)}"`;
				} catch {
					return `${attr}="${path}"`;
				}
			}
		);

		// Fetch + rewrite CSS
		const styles = (
			await Promise.all(
				linkUrls.map(async (href) => {
					try {
						const r = await fetch(href, { headers: FAKE_HEADERS });
						const css = await r.text();
						return rewriteUrlsInText(css, baseUrl);
					} catch {
						return "";
					}
				})
			)
		).filter(Boolean);

		// Fetch + rewrite JS
		const scripts = (
			await Promise.all(
				scriptUrls.map(async (src) => {
					try {
						const r = await fetch(src, { headers: FAKE_HEADERS });
						const js = await r.text();
						return rewriteUrlsInText(js, baseUrl);
					} catch {
						return "";
					}
				})
			)
		).filter(Boolean);

		return {
			head: headParts,
			body: html,
			styles,
			scripts,
			baseUrl
		};
	} catch (e) {
		console.error(e);
		return { error: "Failed to fetch page" };
	}
}

/** Generic proxy for any subsequent request made by the page's JS */
export async function proxyRequest(data: FormData) {
	const url = data.get("url");
	const method = (data.get("method") as string) || "GET";
	const headersJson = data.get("headers") as string | null;
	const body = data.get("body") as string | null; // text or base64
	const isBase64 = data.get("isBase64") === "1";

	if (typeof url !== "string" || !isValidUrl(url)) {
		return { error: "Invalid URL" };
	}

	const target = url.startsWith("http") ? url : `https://${url}`;

	try {
		const headers: HeadersInit = { ...FAKE_HEADERS };

		if (headersJson) {
			try {
				const extra = JSON.parse(headersJson);
				Object.assign(headers, extra);
			} catch {
				/* ignore bad headers */
			}
		}

		// Never forward host/cookie from the client blindly (security)
		delete (headers as any)["host"];
		delete (headers as any)["Host"];

		const init: RequestInit = {
			method,
			headers,
			redirect: "follow"
		};

		if (body && method !== "GET" && method !== "HEAD") {
			init.body = isBase64 ? Buffer.from(body, "base64") : body;
		}

		const res = await fetch(target, init);

		const contentType = res.headers.get("content-type") || "";
		const isText =
			contentType.includes("text/") ||
			contentType.includes("json") ||
			contentType.includes("javascript") ||
			contentType.includes("xml") ||
			contentType.includes("css");

		let responseBody: string;
		let responseIsBase64 = false;

		if (isText) {
			responseBody = await res.text();
			// rewrite urls inside the response when useful
			if (contentType.includes("css") || contentType.includes("javascript")) {
				responseBody = rewriteUrlsInText(responseBody, target);
			}
		} else {
			const buf = await res.arrayBuffer();
			responseBody = Buffer.from(buf).toString("base64");
			responseIsBase64 = true;
		}

		const responseHeaders: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			// filter some headers that break the browser when proxied
			if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) {
				responseHeaders[k] = v;
			}
		});

		return {
			status: res.status,
			statusText: res.statusText,
			headers: responseHeaders,
			body: responseBody,
			isBase64: responseIsBase64
		};
	} catch (e) {
		console.error(e);
		return { error: "Proxy request failed" };
	}
}
