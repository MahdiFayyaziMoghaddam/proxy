"use client";

import { useEffect, useRef, useState } from "react";
import { request } from "./actions";

export default function Home() {
	const [data, setData] = useState<string>("");
	const rootRef = useRef<HTMLHtmlElement>(null);
	useEffect(() => {
		const url = prompt("Enter Target URL:") || "";
		const formData = new FormData();
		formData.append("url", url);
		request(formData).then((d) => {
			if (typeof d !== "object") return;
			document.body.innerHTML = `${d.body} ${d.scripts.length > 0 ? `<script>${d.scripts.join(" ")}</script>` : ""}`;
			document.head.innerHTML = `${d.head} ${d.styles.length > 0 ? `<style>${d.styles.join(" ")}</style>` : ""}`;

			// document.head?.insertAdjacentHTML("afterbegin", d.styles.join(" "));
		});
	}, []);
	return <></>;
}
