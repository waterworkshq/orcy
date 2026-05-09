import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => ({
	plugins: [
		react(),
		{
			name: "strip-lazy-preloads",
			enforce: "post",
			transformIndexHtml: {
				order: "post",
				handler(html: string) {
					return html.replace(
						/<link\s+rel="modulepreload"[^>]*href="[^"]*\/(vendor-(?:charts|editor|markdown|flow|dagre))-[^"]*"[^>]*>/g,
						"",
					);
				},
			},
		},
	],
	base: mode === 'development' ? '/' : '/app/',
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		port: 5173,
		proxy: {
			"/api": {
				target: "http://127.0.0.1:3000",
				changeOrigin: true,
			},
			"/sse": {
				target: "http://127.0.0.1:3000",
				changeOrigin: true,
			},
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		chunkSizeWarningLimit: 600,
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{
							name: "vendor-icons",
							test: /[\\/]node_modules[\\/]lucide-react/,
							priority: 30,
						},
						{
							name: "vendor-flow",
							test: /[\\/]node_modules[\\/]@xyflow/,
							priority: 30,
						},
						{
							name: "vendor-query",
							test: /[\\/]node_modules[\\/]@tanstack/,
							priority: 30,
						},
						{
							name: "vendor-react",
							test: /[\\/]node_modules[\\/](react[\\/]|react-dom|scheduler|zustand)/,
							priority: 30,
						},
						{
							name: "vendor-editor",
							test: /[\\/]node_modules[\\/](@tiptap|prosemirror|lowlight)/,
							priority: 30,
						},
						{
							name: "vendor-dnd",
							test: /[\\/]node_modules[\\/]@dnd-kit/,
							priority: 30,
						},
						{
							name: "vendor-charts",
							test: /[\\/]node_modules[\\/](recharts|d3-)/,
							priority: 30,
						},
						{
							name: "vendor-router",
							test: /[\\/]node_modules[\\/](react-router|@remix-run)/,
							priority: 30,
						},
						{
							name: "vendor-dagre",
							test: /[\\/]node_modules[\\/](dagre|graphlib)/,
							priority: 25,
						},
						{
							name: "vendor-markdown",
							test: /[\\/]node_modules[\\/](react-markdown|remark-|unified|hast-|mdast-|micromark)/,
							priority: 25,
						},
						{
							name: "vendor",
							test: /[\\/]node_modules/,
							priority: 10,
							maxSize: 500000,
						},
						{
							name: "common",
							minShareCount: 2,
							minSize: 30000,
							priority: 5,
						},
					],
				},
			},
		},
	},
}));
