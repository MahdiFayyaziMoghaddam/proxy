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

export async function request(data: FormData) {
	const url = data.get("url");
	const urlRegex = /^(https?:\/\/)?([\w-]+\.)+[\w-]+(\/[\w\-./?%&=]*)?$/;

	if (typeof url !== "string" || !urlRegex.test(url)) {
		return "Invalid URL";
	}

	const baseUrl = url.startsWith("http") ? url : `https://${url}`;

	try {
		const res = await fetch(baseUrl, {
			headers: FAKE_HEADERS,
			redirect: "follow"
		});

		let html = await res.text();

		// Extract external scripts
		const scriptUrls = [
			...new Set(
				[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => {
					try {
						return m[1].startsWith("http") ? m[1] : new URL(m[1], baseUrl).href;
					} catch {
						return null;
					}
				})
			)
		].filter(Boolean) as string[];

		// Extract stylesheets
		const linkUrls = [
			...new Set(
				[...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].map((m) => {
					try {
						return m[1].startsWith("http") ? m[1] : new URL(m[1], baseUrl).href;
					} catch {
						return null;
					}
				})
			)
		].filter(Boolean) as string[];

		// Extract useful head parts
		const headParts = [
			...(html.match(/<title[^>]*>[\s\S]*?<\/title>/gi) || []),
			...(html.match(/<meta[^>]*>/gi) || [])
		].join("\n");

		// Clean the HTML
		html = html
			.replace(/<script[^>]+src=["'][^"']+["'][^>]*>\s*<\/script>/gi, "")
			.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, "")
			.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, "")
			.replace(/<meta[^>]*>/gi, "");

		// Make relative URLs absolute
		html = html.replace(
			/(href|src|srcset)=["'](?!https?:\/\/|\/\/|data:|#|javascript:)([^"']+)["']/gi,
			(_, attr, path) => {
				try {
					if (attr === "srcset") {
						// simple srcset handling
						const parts = path.split(",").map((p: string) => {
							const [urlPart, size] = p.trim().split(/\s+/);
							return `${new URL(urlPart, baseUrl).href}${size ? " " + size : ""}`;
						});
						return `srcset="${parts.join(", ")}"`;
					}
					return `${attr}="${new URL(path, baseUrl).href}"`;
				} catch {
					return `${attr}="${path}"`;
				}
			}
		);

		// Fetch CSS with same headers
		const styles = (
			await Promise.all(
				linkUrls.map(async (href) => {
					try {
						const r = await fetch(href, { headers: FAKE_HEADERS });
						return await r.text();
					} catch {
						return "";
					}
				})
			)
		).filter(Boolean);

		// Fetch JS with same headers
		const scripts = (
			await Promise.all(
				scriptUrls.map(async (src) => {
					try {
						const r = await fetch(src, { headers: FAKE_HEADERS });
						return await r.text();
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
			scripts
		};
	} catch (e) {
		return "Failed to fetch";
	}
}
