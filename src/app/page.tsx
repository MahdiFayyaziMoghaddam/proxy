"use client";

import { useEffect } from "react";
import { request, proxyRequest } from "./actions";

export default function Home() {
	useEffect(() => {
		const load = async (url: string) => {
			const formData = new FormData();
			formData.append("url", url);

			const result = await request(formData);

			if ("error" in result) {
				alert(result.error);
				return;
			}

			const { head, body, styles, scripts, baseUrl } = result;

			// 1. Clear & inject head
			document.head.innerHTML = "";
			document.head.insertAdjacentHTML("afterbegin", head);

			if (styles.length) {
				const style = document.createElement("style");
				style.textContent = styles.join("\n");
				document.head.appendChild(style);
			}

			// 2. CRITICAL: install interceptors BEFORE any third-party scripts run
			installInterceptors(baseUrl);

			// 3. Inject body
			document.body.innerHTML = body;

			// 4. Inject the collected scripts (they now go through the interceptors)
			scripts.forEach((code) => {
				const script = document.createElement("script");
				script.textContent = code;
				document.body.appendChild(script);
			});

			// 5. Handle <a> clicks (SPA-style navigation)
			document.addEventListener(
				"click",
				async (e) => {
					const a = (e.target as HTMLElement).closest("a");
					if (!a) return;

					e.preventDefault();
					const href = a.href;
					if (!href || href.startsWith("javascript:") || href.startsWith("#")) return;

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

/** Install fetch + XHR + dynamic element interceptors */
function installInterceptors(baseUrl: string) {
	// ---------- fetch ----------
	const originalFetch = window.fetch.bind(window);

	window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

		// allow same-origin or already-proxied requests to pass through if needed
		if (url.startsWith("data:") || url.startsWith("blob:")) {
			return originalFetch(input, init);
		}

		const form = new FormData();
		form.append("url", url);
		form.append("method", init?.method || "GET");

		if (init?.headers) {
			const h: Record<string, string> = {};
			if (init.headers instanceof Headers) {
				init.headers.forEach((v, k) => (h[k] = v));
			} else if (Array.isArray(init.headers)) {
				init.headers.forEach(([k, v]) => (h[k] = v));
			} else {
				Object.assign(h, init.headers);
			}
			form.append("headers", JSON.stringify(h));
		}

		if (init?.body) {
			if (typeof init.body === "string") {
				form.append("body", init.body);
			} else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
				form.append("body", btoa(String.fromCharCode(...new Uint8Array(init.body as ArrayBuffer))));
				form.append("isBase64", "1");
			} else if (init.body instanceof Blob) {
				const buf = await init.body.arrayBuffer();
				form.append("body", btoa(String.fromCharCode(...new Uint8Array(buf))));
				form.append("isBase64", "1");
			} else {
				// FormData / URLSearchParams → let the browser serialize
				form.append("body", String(init.body));
			}
		}

		const proxied = await proxyRequest(form);

		if ("error" in proxied) {
			throw new Error(proxied.error);
		}

		const body = proxied.isBase64 ? Uint8Array.from(atob(proxied.body), (c) => c.charCodeAt(0)) : proxied.body;

		return new Response(body, {
			status: proxied.status,
			statusText: proxied.statusText,
			headers: proxied.headers
		});
	};

	// ---------- XMLHttpRequest ----------
	const OriginalXHR = window.XMLHttpRequest;

	class ProxiedXHR extends OriginalXHR {
		private _url = "";
		private _method = "GET";
		private _headers: Record<string, string> = {};
		private _body: any = null;

		open(method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
			this._method = method;
			this._url = typeof url === "string" ? url : url.href;
			// we still call super so readyState changes work, but we will never actually send to the real network
			super.open(method, url, async, username, password);
		}

		setRequestHeader(name: string, value: string) {
			this._headers[name] = value;
			// do not call super – we don't want the real request
		}

		send(body?: Document | XMLHttpRequestBodyInit | null) {
			this._body = body;

			const form = new FormData();
			form.append("url", this._url);
			form.append("method", this._method);
			form.append("headers", JSON.stringify(this._headers));

			if (body) {
				if (typeof body === "string") {
					form.append("body", body);
				} else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
					form.append("body", btoa(String.fromCharCode(...new Uint8Array(body as ArrayBuffer))));
					form.append("isBase64", "1");
				} else if (body instanceof Blob) {
					body.arrayBuffer().then((buf) => {
						form.append("body", btoa(String.fromCharCode(...new Uint8Array(buf))));
						form.append("isBase64", "1");
						this._doProxy(form);
					});
					return;
				} else {
					form.append("body", String(body));
				}
			}

			this._doProxy(form);
		}

		private async _doProxy(form: FormData) {
			try {
				const proxied = await proxyRequest(form);

				if ("error" in proxied) {
					this.dispatchEvent(new Event("error"));
					return;
				}

				// Fake the response
				Object.defineProperty(this, "status", { value: proxied.status });
				Object.defineProperty(this, "statusText", { value: proxied.statusText });
				Object.defineProperty(this, "responseText", {
					value: proxied.isBase64 ? atob(proxied.body) : proxied.body
				});
				Object.defineProperty(this, "response", {
					value: proxied.isBase64 ? Uint8Array.from(atob(proxied.body), (c) => c.charCodeAt(0)) : proxied.body
				});
				Object.defineProperty(this, "readyState", { value: 4 });

				// headers
				const headerStr = Object.entries(proxied.headers)
					.map(([k, v]) => `${k}: ${v}`)
					.join("\r\n");
				Object.defineProperty(this, "getAllResponseHeaders", {
					value: () => headerStr
				});
				Object.defineProperty(this, "getResponseHeader", {
					value: (name: string) => proxied.headers[name.toLowerCase()] || null
				});

				this.dispatchEvent(new Event("readystatechange"));
				this.dispatchEvent(new Event("load"));
				this.dispatchEvent(new Event("loadend"));
			} catch (err) {
				this.dispatchEvent(new Event("error"));
			}
		}
	}

	window.XMLHttpRequest = ProxiedXHR as any;

	// ---------- Dynamic script / link creation ----------
	const originalCreateElement = document.createElement.bind(document);

	document.createElement = function <K extends keyof HTMLElementTagNameMap>(
		tagName: K,
		options?: ElementCreationOptions
	): HTMLElementTagNameMap[K] {
		const el = originalCreateElement(tagName, options);

		if (tagName.toLowerCase() === "script") {
			const script = el as HTMLScriptElement;
			const originalSrcSetter = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src")?.set;

			Object.defineProperty(script, "src", {
				set(value: string) {
					// force the script to be loaded via our proxy by converting it to an inline script later
					// for simplicity we still set the real src but the browser will load it through fetch interceptor
					// (because we already overrode fetch). This is good enough for most cases.
					originalSrcSetter?.call(script, value);
				},
				get() {
					return script.getAttribute("src") || "";
				},
				configurable: true
			});
		}

		if (tagName.toLowerCase() === "link") {
			const link = el as HTMLLinkElement;
			const originalHrefSetter = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "href")?.set;

			Object.defineProperty(link, "href", {
				set(value: string) {
					originalHrefSetter?.call(link, value);
				},
				get() {
					return link.getAttribute("href") || "";
				},
				configurable: true
			});
		}

		return el;
	};
}
