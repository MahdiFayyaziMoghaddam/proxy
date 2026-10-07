"use client";

import { useEffect } from "react";
import { request } from "./actions";

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

			// Clear and inject head
			document.head.innerHTML = "";
			document.head.insertAdjacentHTML("afterbegin", result.head);

			if (result.styles.length) {
				const style = document.createElement("style");
				style.textContent = result.styles.join("\n");
				document.head.appendChild(style);
			}

			// Inject body
			document.body.innerHTML = result.body;

			// Inject scripts
			result.scripts.forEach((code) => {
				const script = document.createElement("script");
				script.textContent = code;
				document.body.appendChild(script);
			});

			// Handle all <a> clicks
			document.addEventListener("click", async (e) => {
				const a = (e.target as HTMLElement).closest("a");
				if (!a) return;

				e.preventDefault();
				const href = a.href;
				if (!href || href.startsWith("javascript:")) return;

				await load(href);
			});
		};

		const target = prompt("Enter Target URL:");
		if (target) load(target);
	}, []);

	return null;
}
