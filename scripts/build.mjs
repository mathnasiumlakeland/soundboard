import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const sourceDir = path.join(rootDir, "site");
const sourceAssetsDir = path.join(sourceDir, "assets");
const distDir = path.join(rootDir, "dist");
const distAssetsDir = path.join(distDir, "assets");

async function prepareDistDir() {
	await rm(distDir, { recursive: true, force: true });
	await mkdir(distAssetsDir, { recursive: true });
}

async function copyStaticFiles() {
	await Promise.all([
		cp(path.join(sourceDir, "index.html"), path.join(distDir, "index.html")),
		cp(path.join(sourceDir, "404.html"), path.join(distDir, "404.html")),
		cp(path.join(sourceAssetsDir, "button-shadow-small.png"), path.join(distAssetsDir, "button-shadow-small.png")),
		cp(path.join(sourceAssetsDir, "button-sprite-small.png"), path.join(distAssetsDir, "button-sprite-small.png")),
		cp(path.join(sourceAssetsDir, "fonts"), path.join(distAssetsDir, "fonts"), { recursive: true })
	]);
}

function minifyCss(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([{}:;,>+~])\s*/g, "$1")
		.replace(/;}/g, "}")
		.trim();
}

async function buildJavascript() {
	const result = await Bun.build({
		entrypoints: [path.join(sourceAssetsDir, "app.js")],
		outdir: distAssetsDir,
		target: "browser",
		format: "esm",
		minify: true
	});

	if (!result.success) {
		for (const log of result.logs) {
			console.error(log);
		}

		throw new Error("Asset build failed.");
	}
}

async function buildStylesheet() {
	const source = await readFile(path.join(sourceAssetsDir, "styles.css"), "utf8");
	await writeFile(path.join(distAssetsDir, "styles.css"), `${minifyCss(source)}\n`);
}

await prepareDistDir();
await Promise.all([copyStaticFiles(), buildJavascript(), buildStylesheet()]);
