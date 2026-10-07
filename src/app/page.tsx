"use client";

import { useEffect } from "react";
import { request, proxyRequest } from "./actions";

export default function Home() {
	useEffect(() => {
		const load = async (url: string) => {
			const formData = new FormData();
			formData.append("url", url);

			const result = await request(formData);
			if (typeof result === "string") {
				alert(result);
				return;
			}

			// clear + inject head
			document.head.innerHTML = "";
			document.head.insertAdjacentHTML("afterbegin", result.head || "");

			if (result.styles!.length) {
				const style = document.createElement("style");
				style.textContent = result.styles!.join("\n");
				document.head.appendChild(style);
			}

			// ---------- interceptors (must be before any third-party scripts) ----------
			installInterceptors();

			// inject body
			document.body.innerHTML = result.body || "";

			// inject the collected scripts
			result.scripts!.forEach((code) => {
				const s = document.createElement("script");
				s.textContent = code;
				document.body.appendChild(s);
			});

			// link clicks
			document.addEventListener(
				"click",
				async (e) => {
					const a = (e.target as HTMLElement).closest("a");
					if (!a) return;
					e.preventDefault();
					const href = a.href;
					if (!href || href.startsWith("javascript:")) return;
					await load(href);
				},
				true
			);
		};

		const target = prompt("Enter Target URL:");
		if (target) load(target);
	}, []);

	return null;
}

// ============================================================
// simple fetch + xhr middleware
// ============================================================
function installInterceptors() {
	// ---- fetch ----
	const originalFetch = window.fetch;
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method || "GET";
		const headers: Record<string, string> = {};

		if (init?.headers) {
			if (init.headers instanceof Headers) {
				init.headers.forEach((v, k) => (headers[k] = v));
			} else if (Array.isArray(init.headers)) {
				init.headers.forEach(([k, v]) => (headers[k] = v));
			} else {
				Object.assign(headers, init.headers);
			}
		}

		let body: string | null = null;
		if (init?.body) {
			if (typeof init.body === "string") body = init.body;
			else if (init.body instanceof FormData) {
				// simple FormData → just skip or stringify later if needed
				body = null;
			} else {
				body = String(init.body);
			}
		}

		const fd = new FormData();
		fd.append("url", url);
		fd.append("method", method);
		fd.append("headers", JSON.stringify(headers));
		if (body) fd.append("body", body);

		const proxied = await proxyRequest(fd);

		return new Response(proxied.body, {
			status: proxied.status,
			headers: proxied.headers
		});
	};

	// ---- XMLHttpRequest ----
	const OriginalXHR = window.XMLHttpRequest;

	class ProxiedXHR extends OriginalXHR {
		private _url = "";
		private _method = "GET";
		private _headers: Record<string, string> = {};
		private _body: any = null;

		open(method: string, url: string | URL, async?: boolean, user?: string | null, password?: string | null) {
			this._method = method;
			this._url = typeof url === "string" ? url : url.href;
			// call original with a dummy so the object is ready
			super.open(method, "about:blank", async !== false, user, password);
		}

		setRequestHeader(name: string, value: string) {
			this._headers[name] = value;
		}

		send(body?: Document | XMLHttpRequestBodyInit | null) {
			this._body = body;

			const fd = new FormData();
			fd.append("url", this._url);
			fd.append("method", this._method);
			fd.append("headers", JSON.stringify(this._headers));
			if (body && typeof body === "string") fd.append("body", body);

			proxyRequest(fd).then((res) => {
				// fake the response
				Object.defineProperty(this, "status", { value: res.status });
				Object.defineProperty(this, "statusText", { value: "" });
				Object.defineProperty(this, "responseText", { value: res.body });
				Object.defineProperty(this, "response", { value: res.body });
				Object.defineProperty(this, "readyState", { value: 4 });

				// fire events
				this.dispatchEvent(new Event("readystatechange"));
				this.dispatchEvent(new Event("load"));
				this.dispatchEvent(new Event("loadend"));
			});
		}
	}

	(window as any).XMLHttpRequest = ProxiedXHR;
}
