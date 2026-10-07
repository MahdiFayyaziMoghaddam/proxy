"use server";

export async function request(data: FormData) {
	const url = data.get("url");
	const urlRegex = /^(https?:\/\/)?([\w-]+\.)+[\w-]+(\/[\w\-./?%&=]*)?$/;

	if (typeof url === "string" && urlRegex.test(url)) {
		const baseUrl = url.startsWith("http") ? url : `https://${url}`;
		try {
			const res = await fetch(baseUrl);
			let html = await res.text();
			const scriptsUrls = [
				...new Set(
					[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) =>
						m[1].startsWith("http") ? m[1] : baseUrl + m[1]
					)
				)
			];
			const links = [
				...new Set(
					[...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi)].map((m) =>
						m[1].startsWith("http") ? m[1] : baseUrl + m[1]
					)
				)
			];

			html = html.replace(/<script[^>]+src=["'][^"']+["'][^>]*>\s*<\/script>/gi, "");
			html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, "");

			html = html.replace(/(href|src)=["'](?!https?:\/\/|\/\/|data:)([^"']+)["']/gi, (_, attr, path) => {
				return `${attr}="${new URL(path, baseUrl).href}"`;
			});

			// Extract head parts (title, meta, link)
			const head = [
				...(html.match(/<title[^>]*>[\s\S]*?<\/title>/gi) || []),
				...(html.match(/<meta[^>]*>/gi) || []),
				...(html.match(/<link[^>]*>/gi) || [])
			].join("\n");

			// Remove head parts from html
			html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, "");
			html = html.replace(/<meta[^>]*>/gi, "");
			html = html.replace(/<link[^>]*>/gi, "");

			// Remove script tags
			html = html.replace(/<script[^>]+src=["'][^"']+["'][^>]*>\s*<\/script>/gi, "");

			const styles = await Promise.all(
				links.map(async (href) => {
					try {
						const r = await fetch(href);
						return await r.text();
					} catch {
						return "";
					}
				})
			);

			const scripts = await Promise.all(
				scriptsUrls.map(async (src) => {
					try {
						const r = await fetch(src);
						return await r.text();
					} catch {
						return "";
					}
				})
			);

			return {
				body: html,
				styles: styles.filter(Boolean), // only successful ones
				scripts: scripts.filter(Boolean),
				head
			};
		} catch (e) {
			return "Invalid URL";
		}
	} else {
		return "Invalid URL";
	}
}
