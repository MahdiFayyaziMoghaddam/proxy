"use client";

import { useEffect, useRef, useState } from "react";
import { request } from "./actions";

export default function RootLayout({ children }: LayoutProps<"/">) {
	return (
		<html>
			<head></head>
			<body>{children}</body>
		</html>
	);
}
