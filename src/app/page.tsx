"use client";

import { useEffect } from "react";
import { request, proxyRequest } from "./actions";

// module-level so HMR / StrictMode double-mount doesn't double-patch
let patched = false;

export default function Home() {
	useEffect(() => {
		let destroyed = false;

		// ---------- navigation ----------
		const load = async (url: string) => {
			const result = await request(url);
			if (destroyed) return;
			if (typeof result === "string") {
				alert(result);
				return;
			}

			// remove only OUR previous injection
			document.querySelectorAll("[data-injected]").forEach((n) => n.remove());

			// base tag so any un-rewritten relative URL still resolves
			const base = document.createElement("base");
			base.href = result.baseUrl;
			base.setAttribute("data-injected", "");
			document.head.appendChild(base);

			// head bits (title + meta)
			if (result.head) {
				const tpl = document.createElement("template");
				tpl.innerHTML = result.head;
				const frag = document.createDocumentFragment();
				[...tpl.content.children].forEach((n) => {
					n.setAttribute("data-injected", "");
					frag.appendChild(n);
				});
				document.head.appendChild(frag);
			}

			// inlined CSS
			if (result.styles) {
				const s = document.createElement("style");
				s.setAttribute("data-injected", "");
				s.textContent = result.styles;
				document.head.appendChild(s);
			}

			// patch fetch/XHR exactly once
			if (!patched) {
				installInterceptors();
				patched = true;
			}

			// body
			document.body.innerHTML = result.body ?? "";

			// scripts (already routed through /__asset)
			result.scriptUrls?.forEach((src) => {
				const s = document.createElement("script");
				s.src = src;
				s.async = false; // preserve execution order like classic <script>
				s.setAttribute("data-injected", "");
				document.body.appendChild(s);
			});
		};

		// ---------- one click listener, forever ----------
		const onClick = (e: MouseEvent) => {
			const a = (e.target as HTMLElement)?.closest?.("a") as HTMLAnchorElement | null;
			if (!a) return;
			const href = a.href;
			if (!href || href.startsWith("javascript:")) return;
			e.preventDefault();
			load(href);
		};
		document.addEventListener("click", onClick, true);

		// ---------- one form listener, forever ----------
		const onSubmit = (e: SubmitEvent) => {
			const form = e.target as HTMLFormElement;
			if (!form || form.tagName !== "FORM") return;
			e.preventDefault();
			const action = form.action || form.getAttribute("action") || location.href;
			const method = (form.method || "GET").toUpperCase();
			if (method === "GET") {
				const fd = new FormData(form);
				const qs = new URLSearchParams(fd as any).toString();
				load(action + (action.includes("?") ? "&" : "?") + qs);
			} else {
				// for POST just navigate to the action URL for now
				load(action);
			}
		};
		document.addEventListener("submit", onSubmit, true);

		const target = prompt("Enter Target URL:");
		if (target) load(target);

		return () => {
			destroyed = true;
			document.removeEventListener("click", onClick, true);
			document.removeEventListener("submit", onSubmit, true);
		};
	}, []);

	return null;
}

// ============================================================
// interceptors
// ============================================================
function installInterceptors() {
	// ---------- fetch ----------
	const originalFetch = window.fetch.bind(window);

	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		const { url, method } = req;

		// don't proxy our own asset requests
		if (url.startsWith(location.origin + "/__asset")) {
			return originalFetch(input, init);
		}

		const headers: Record<string, string> = {};
		req.headers.forEach((v, k) => {
			headers[k] = v;
		});

		const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
		const body = hasBody ? await req.text() : undefined;

		const res = await proxyRequest({ url, method, headers, body });

		return new Response(res.body, {
			status: res.status,
			headers: res.headers
		});
	};

	// ---------- XHR ----------
	class ProxiedXHR extends EventTarget {
		static UNSENT = 0;
		static OPENED = 1;
		static HEADERS_RECEIVED = 2;
		static LOADING = 3;
		static DONE = 4;

		UNSENT = 0;
		OPENED = 1;
		HEADERS_RECEIVED = 2;
		LOADING = 3;
		DONE = 4;

		readyState = 0;
		status = 0;
		statusText = "";
		response: any = "";
		responseText = "";
		responseType: XMLHttpRequestResponseType = "";
		responseURL = "";
		responseXML: Document | null = null;
		withCredentials = false;
		timeout = 0;
		upload: any = { addEventListener() {}, removeEventListener() {} };

		onreadystatechange: ((this: any, ev: Event) => any) | null = null;
		onload: ((this: any, ev: ProgressEvent) => any) | null = null;
		onerror: ((this: any, ev: ProgressEvent) => any) | null = null;
		onloadend: ((this: any, ev: ProgressEvent) => any) | null = null;
		onabort: ((this: any, ev: ProgressEvent) => any) | null = null;
		ontimeout: ((this: any, ev: ProgressEvent) => any) | null = null;

		private _method = "GET";
		private _url = "";
		private _headers: Record<string, string> = {};
		private _aborted = false;

		open(method: string, url: string | URL) {
			this._method = method.toUpperCase();
			this._url = typeof url === "string" ? url : url.href;
			this._setReadyState(1);
		}

		setRequestHeader(name: string, value: string) {
			this._headers[name] = value;
		}

		getResponseHeader(name: string): string | null {
			return this._resHeaders?.[name.toLowerCase()] ?? null;
		}

		getAllResponseHeaders(): string {
			if (!this._resHeaders) return "";
			return Object.entries(this._resHeaders)
				.map(([k, v]) => `${k}: ${v}`)
				.join("\r\n");
		}

		abort() {
			this._aborted = true;
			this.dispatchEvent(new ProgressEvent("abort"));
			this.dispatchEvent(new ProgressEvent("loadend"));
		}

		async send(body?: Document | XMLHttpRequestBodyInit | null) {
			this._aborted = false;

			const hasBody = !["GET", "HEAD"].includes(this._method);
			let payload: string | undefined;
			if (hasBody && body != null) {
				if (typeof body === "string") payload = body;
				else if (body instanceof URLSearchParams) payload = body.toString();
				else if (body instanceof FormData) {
					// best-effort: serialize as urlencoded
					payload = new URLSearchParams(body as any).toString();
					this._headers["content-type"] = "application/x-www-form-urlencoded";
				} else {
					payload = String(body);
				}
			}

			try {
				const res = await proxyRequest({
					url: this._url,
					method: this._method,
					headers: this._headers,
					body: payload
				});

				if (this._aborted) return;

				this.status = res.status;
				this.statusText = "";
				this.responseURL = res.finalUrl ?? this._url;
				this._resHeaders = {};
				for (const [k, v] of Object.entries(res.headers)) {
					this._resHeaders[k.toLowerCase()] = v;
				}

				this._setReadyState(2);
				this._setReadyState(3);

				this.responseText = res.body;
				if (this.responseType === "json") {
					try {
						this.response = JSON.parse(res.body);
					} catch {
						this.response = null;
					}
				} else {
					this.response = res.body;
				}

				this._setReadyState(4);
				this.onload?.call(this, new ProgressEvent("load"));
				this.dispatchEvent(new ProgressEvent("load"));
				this.onloadend?.call(this, new ProgressEvent("loadend"));
				this.dispatchEvent(new ProgressEvent("loadend"));
			} catch (err) {
				if (this._aborted) return;
				this.onerror?.call(this, new ProgressEvent("error"));
				this.dispatchEvent(new ProgressEvent("error"));
				this.dispatchEvent(new ProgressEvent("loadend"));
			}
		}

		private _resHeaders: Record<string, string> | null = null;

		private _setReadyState(s: number) {
			this.readyState = s;
			const ev = new Event("readystatechange");
			this.onreadystatechange?.call(this, ev);
			this.dispatchEvent(ev);
		}
	}

	(window as any).XMLHttpRequest = ProxiedXHR;
}
