import { NextRequest } from "next/server";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const STRIP_RES = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"set-cookie",
	"content-security-policy",
	"content-security-policy-report-only",
	"x-frame-options"
]);

function isSafeHost(host: string): boolean {
	const h = host.split(":")[0].toLowerCase();
	if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
	if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
	if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return false;
	return true;
}

export async function GET(req: NextRequest, ctx: { params: { path: string[] } }) {
	// path is [proto, host, ...rest]
	const [proto, host, ...rest] = ctx.params.path;
	if (!proto || !host || !["http", "https"].includes(proto)) {
		return new Response("bad path", { status: 400 });
	}
	if (!isSafeHost(host)) {
		return new Response("blocked host", { status: 403 });
	}

	const url = new URL(req.url);
	const target = `${proto}://${host}/${rest.join("/")}${url.search}`;

	let upstream: Response;
	try {
		upstream = await fetch(target, {
			headers: { "user-agent": UA, accept: "*/*" },
			redirect: "follow"
		});
	} catch {
		return new Response("upstream failed", { status: 502 });
	}

	const headers = new Headers();
	upstream.headers.forEach((v, k) => {
		if (!STRIP_RES.has(k.toLowerCase())) headers.set(k, v);
	});
	// make sure the browser caches these reasonably
	if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=300");

	return new Response(upstream.body, {
		status: upstream.status,
		headers
	});
}
