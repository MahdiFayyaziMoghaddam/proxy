"use server";

export async function request(data: FormData) {
	const url = data.get("url");
	const urlRegex = /^(https?:\/\/)?([\w-]+\.)+[\w-]+(\/[\w\-./?%&=]*)?$/;

	if (typeof url !== "string" || !urlRegex.test(url)) {
		return "Invalid URL";
	}

	const baseUrl = url.startsWith("http") ? url : `https://${url}`;

	try {
		const res = await fetch(baseUrl, {
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
			}
		});

		let html = await res.text();

		// Extract script srcs
		const scriptUrls = [
			...new Set(
				[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) =>
					m[1].startsWith("http") ? m[1] : new URL(m[1], baseUrl).href
				)
			)
		];

		// Extract stylesheet hrefs
		const linkUrls = [
			...new Set(
				[...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].map((m) =>
					m[1].startsWith("http") ? m[1] : new URL(m[1], baseUrl).href
				)
			)
		];

		// Extract head parts
		const headParts = [
			...(html.match(/<title[^>]*>[\s\S]*?<\/title>/gi) || []),
			...(html.match(/<meta[^>]*>/gi) || [])
		].join("\n");

		// Clean html
		html = html
			.replace(/<script[^>]+src=["'][^"']+["'][^>]*>\s*<\/script>/gi, "")
			.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, "")
			.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, "")
			.replace(/<meta[^>]*>/gi, "");

		// Make relative urls absolute
		html = html.replace(/(href|src)=["'](?!https?:\/\/|\/\/|data:|#)([^"']+)["']/gi, (_, attr, path) => {
			try {
				return `${attr}="${new URL(path, baseUrl).href}"`;
			} catch {
				return `${attr}="${path}"`;
			}
		});

		// Fetch CSS
		const styles = (
			await Promise.all(
				linkUrls.map(async (href) => {
					try {
						const r = await fetch(href);
						return await r.text();
					} catch {
						return "";
					}
				})
			)
		).filter(Boolean);

		// Fetch JS
		const scripts = (
			await Promise.all(
				scriptUrls.map(async (src) => {
					try {
						const r = await fetch(src);
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
