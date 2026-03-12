import { buttonData } from "./buttons.js";

const SOUND_CACHE_NAME = "mathnasium-soundboard-v1";
const CACHE_META_KEY = "mathnasium-soundboard-cache-meta-v1";
const CACHE_TTL_MS = 60 * 60 * 1000;
const PRESS_DURATION_MS = 90;

const buttonGrid = document.querySelector(".instants");
const announcement = document.querySelector("#announcement");
const audio = document.querySelector("#soundboard-audio");
const passwordModal = document.querySelector("#password-modal");
const passwordForm = document.querySelector("#password-form");
const passwordInput = document.querySelector("#password-input");
const passwordModalTitle = document.querySelector("#password-modal-title");
const passwordCancelButtons = [...document.querySelectorAll("[data-password-cancel]")];
const labelCollator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base"
});

const objectUrlById = new Map();
const warmupById = new Map();
const pressTimeoutById = new Map();
let buttons = [];
let playbackToken = 0;
let activePasswordRequest = null;
let cacheMeta = null;
let soundCachePromise = null;

function createButtonCard(entry) {
	const article = document.createElement("article");
	article.className = "instant";

	const background = document.createElement("div");
	background.className = "circle small-button-background";
	background.style.backgroundColor = entry.color;

	const button = document.createElement("button");
	button.type = "button";
	button.className = "small-button";
	button.dataset.sound = "";
	button.dataset.id = entry.id;
	button.dataset.label = entry.label;
	button.dataset.url = entry.url;
	button.setAttribute("aria-label", `Play ${entry.label}`);

	if (entry.password) {
		button.dataset.password = entry.password;
	}

	const shadow = document.createElement("div");
	shadow.className = "small-button-shadow";
	shadow.setAttribute("aria-hidden", "true");

	const label = document.createElement("span");
	label.className = "instant-link";
	label.textContent = entry.label;

	article.append(background, button, shadow, label);
	return article;
}

function renderButtons(entries) {
	if (!buttonGrid) {
		return [];
	}

	const fragment = document.createDocumentFragment();
	const sortedEntries = [...entries].sort((left, right) => labelCollator.compare(left.label, right.label));

	for (const entry of sortedEntries) {
		fragment.append(createButtonCard(entry));
	}

	buttonGrid.replaceChildren(fragment);
	return [...buttonGrid.querySelectorAll("[data-sound]")];
}

function setAnnouncement(message) {
	if (announcement) {
		announcement.textContent = message;
	}
}

function getCacheMeta() {
	if (cacheMeta) {
		return cacheMeta;
	}

	try {
		cacheMeta = JSON.parse(window.localStorage.getItem(CACHE_META_KEY) ?? "{}");
	} catch {
		cacheMeta = {};
	}

	return cacheMeta;
}

function persistCacheMeta() {
	try {
		window.localStorage.setItem(CACHE_META_KEY, JSON.stringify(getCacheMeta()));
	} catch {
		// Ignore storage failures and fall back to uncapped browser behavior.
	}
}

function rememberCacheTimestamp(sourceUrl) {
	const meta = getCacheMeta();
	meta[sourceUrl] = Date.now();
	persistCacheMeta();
}

function forgetCacheTimestamp(sourceUrl) {
	const meta = getCacheMeta();
	if (!(sourceUrl in meta)) {
		return;
	}

	delete meta[sourceUrl];
	persistCacheMeta();
}

function getCachedAt(sourceUrl) {
	const cachedAt = getCacheMeta()[sourceUrl];
	return typeof cachedAt === "number" ? cachedAt : 0;
}

function isCacheFresh(sourceUrl) {
	const cachedAt = getCachedAt(sourceUrl);
	return cachedAt > 0 && Date.now() - cachedAt <= CACHE_TTL_MS;
}

function getSoundCache() {
	if (!("caches" in window)) {
		return null;
	}

	soundCachePromise ??= caches.open(SOUND_CACHE_NAME);
	return soundCachePromise;
}

function rememberObjectUrl(id, objectUrl) {
	const existingObjectUrl = objectUrlById.get(id);
	if (existingObjectUrl) {
		URL.revokeObjectURL(existingObjectUrl);
	}

	objectUrlById.set(id, objectUrl);
}

function forgetObjectUrl(id) {
	const existingObjectUrl = objectUrlById.get(id);
	if (!existingObjectUrl) {
		return;
	}

	URL.revokeObjectURL(existingObjectUrl);
	objectUrlById.delete(id);
}

async function purgeExpiredCacheEntry(id, sourceUrl) {
	forgetObjectUrl(id);
	forgetCacheTimestamp(sourceUrl);

	const cache = getSoundCache();
	if (!cache) {
		return;
	}

	try {
		await (await cache).delete(sourceUrl);
	} catch {
		// Ignore cache cleanup failures.
	}
}

async function getCachedObjectUrl(id, sourceUrl) {
	const existingObjectUrl = objectUrlById.get(id);
	if (existingObjectUrl) {
		if (isCacheFresh(sourceUrl)) {
			return existingObjectUrl;
		}

		await purgeExpiredCacheEntry(id, sourceUrl);
	}

	if (!isCacheFresh(sourceUrl)) {
		await purgeExpiredCacheEntry(id, sourceUrl);
		return null;
	}

	const cache = getSoundCache();
	if (!cache) {
		forgetCacheTimestamp(sourceUrl);
		return null;
	}

	try {
		const cachedResponse = await (await cache).match(sourceUrl);
		if (!cachedResponse || cachedResponse.type === "opaque") {
			forgetCacheTimestamp(sourceUrl);
			return null;
		}

		const blob = await cachedResponse.blob();
		if (!blob.size) {
			await purgeExpiredCacheEntry(id, sourceUrl);
			return null;
		}

		const objectUrl = URL.createObjectURL(blob);
		rememberObjectUrl(id, objectUrl);
		return objectUrl;
	} catch {
		return null;
	}
}

function pulseButton(button) {
	const id = button.dataset.id;
	if (!id) {
		return;
	}

	const existingTimeout = pressTimeoutById.get(id);
	if (existingTimeout) {
		window.clearTimeout(existingTimeout);
	}

	button.classList.remove("pressed");
	void button.offsetWidth;
	button.classList.add("pressed");

	const timeout = window.setTimeout(() => {
		button.classList.remove("pressed");
		pressTimeoutById.delete(id);
	}, PRESS_DURATION_MS);

	pressTimeoutById.set(id, timeout);
}

async function ensureButtonAccess(button) {
	const label = button.dataset.label ?? "this sound";
	const password = button.dataset.password;

	if (!password) {
		return true;
	}

	const enteredPassword = await requestPassword(label);
	if (enteredPassword === null) {
		setAnnouncement(`${label} cancelled.`);
		return false;
	}

	if (enteredPassword !== password) {
		setAnnouncement(`Incorrect password for ${label}.`);
		return false;
	}

	setAnnouncement(`Password accepted for ${label}.`);
	return true;
}

function requestPassword(label) {
	if (!passwordModal || !passwordForm || !passwordInput || !passwordModalTitle) {
		setAnnouncement(`Password dialog unavailable for ${label}.`);
		return Promise.resolve(null);
	}

	if (activePasswordRequest) {
		passwordModalTitle.textContent = `Enter password for ${label}`;
		passwordInput.value = "";
		window.setTimeout(() => passwordInput.focus(), 0);
		return activePasswordRequest.promise;
	}

	passwordModal.hidden = false;
	passwordModalTitle.textContent = `Enter password for ${label}`;
	passwordInput.value = "";

	const promise = new Promise((resolve) => {
		activePasswordRequest = { resolve, promise: null };

		const cleanup = (value) => {
			passwordModal.hidden = true;
			passwordForm.removeEventListener("submit", handleSubmit);
			passwordCancelButtons.forEach((button) => {
				button.removeEventListener("click", handleCancel);
			});
			document.removeEventListener("keydown", handleKeyDown);
			activePasswordRequest = null;
			resolve(value);
		};

		const handleSubmit = (event) => {
			event.preventDefault();
			event.stopPropagation();
			cleanup(passwordInput.value);
		};

		const handleCancel = (event) => {
			event.preventDefault();
			event.stopPropagation();
			cleanup(null);
		};

		const handleKeyDown = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				cleanup(null);
			}
		};

		passwordForm.addEventListener("submit", handleSubmit);
		passwordCancelButtons.forEach((button) => {
			button.addEventListener("click", handleCancel);
		});
		document.addEventListener("keydown", handleKeyDown);
		window.setTimeout(() => passwordInput.focus(), 0);
	});

	activePasswordRequest.promise = promise;
	return promise;
}

function stopCurrentPlayback() {
	if (!audio) {
		return;
	}

	audio.pause();
	audio.currentTime = 0;
	audio.removeAttribute("src");
	audio.load();
	buttons.forEach((button) => button.classList.remove("is-playing"));
}

async function warmSound(button) {
	const id = button.dataset.id;
	const sourceUrl = button.dataset.url;

	if (!id || !sourceUrl) {
		return null;
	}

	const cachedObjectUrl = await getCachedObjectUrl(id, sourceUrl);
	if (cachedObjectUrl) {
		return cachedObjectUrl;
	}

	const inFlightWarmup = warmupById.get(id);
	if (inFlightWarmup) {
		return inFlightWarmup;
	}

	const warmup = (async () => {
		try {
			const response = await fetch(sourceUrl, { mode: "cors" });
			if (!response.ok) {
				throw new Error(`Unexpected response ${response.status}`);
			}

			const cache = getSoundCache();
			if (cache) {
				try {
					await (await cache).put(sourceUrl, response.clone());
				} catch {
					// Keep current-session replay fast even if persistent cache writes fail.
				}
			}

			const blob = await response.blob();
			if (!blob.size) {
				throw new Error("Received an empty audio file.");
			}

			const objectUrl = URL.createObjectURL(blob);
			rememberObjectUrl(id, objectUrl);
			rememberCacheTimestamp(sourceUrl);
			return objectUrl;
		} catch {
			return null;
		} finally {
			warmupById.delete(id);
		}
	})();

	warmupById.set(id, warmup);
	return warmup;
}

async function playButton(button) {
	const id = button.dataset.id;
	const label = button.dataset.label;
	const sourceUrl = button.dataset.url;

	if (!audio || !id || !label || !sourceUrl) {
		return;
	}

	const hasAccess = await ensureButtonAccess(button);
	if (!hasAccess) {
		return;
	}

	pulseButton(button);

	const currentToken = ++playbackToken;
	const cachedObjectUrl = await getCachedObjectUrl(id, sourceUrl);
	if (currentToken !== playbackToken) {
		return;
	}

	const playbackUrl = cachedObjectUrl ?? sourceUrl;

	try {
		stopCurrentPlayback();
		audio.src = playbackUrl;
		button.classList.add("is-playing");
		await audio.play();
	} catch {
		if (currentToken !== playbackToken) {
			return;
		}

		button.classList.remove("is-playing");
		setAnnouncement(`Playback for ${label} was blocked. Click the button again.`);
		return;
	}

	if (currentToken !== playbackToken) {
		stopCurrentPlayback();
		return;
	}

	if (cachedObjectUrl) {
		setAnnouncement(`Playing ${label} from local cache.`);
		return;
	}

	setAnnouncement(`Playing ${label}. Warming a browser cache in the background.`);
	void warmSound(button).then((objectUrl) => {
		if (objectUrl) {
			setAnnouncement(`${label} is cached locally for faster replays.`);
		}
	});
}

function getButtonFromEventTarget(target) {
	if (!(target instanceof Element)) {
		return null;
	}

	const button = target.closest("[data-sound]");
	return button instanceof HTMLButtonElement ? button : null;
}

function bindButtonInteractions() {
	if (!buttonGrid) {
		return;
	}

	buttonGrid.addEventListener("pointerdown", (event) => {
		const button = getButtonFromEventTarget(event.target);
		if (!button) {
			return;
		}

		void playButton(button);
	});

	buttonGrid.addEventListener("click", (event) => {
		if (event.detail !== 0) {
			return;
		}

		const button = getButtonFromEventTarget(event.target);
		if (!button) {
			return;
		}

		void playButton(button);
	});
}

buttons = renderButtons(buttonData);
bindButtonInteractions();

if (audio) {
	audio.addEventListener("ended", () => {
		buttons.forEach((button) => button.classList.remove("is-playing"));
	});
}

window.addEventListener("beforeunload", () => {
	stopCurrentPlayback();

	for (const timeout of pressTimeoutById.values()) {
		window.clearTimeout(timeout);
	}

	for (const objectUrl of objectUrlById.values()) {
		URL.revokeObjectURL(objectUrl);
	}
});
