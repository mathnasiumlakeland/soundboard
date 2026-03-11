const SOUND_CACHE_NAME = "mathnasium-soundboard-v1";
const CACHE_META_KEY = "mathnasium-soundboard-cache-meta-v1";
const CACHE_TTL_MS = 60 * 60 * 1000;
const PRESS_DURATION_MS = 135;
const POINTER_CLICK_SUPPRESSION_MS = 350;

const statusText = {
	idle: "Ready",
	loading: "Caching...",
	cached: "Cached locally",
	streamed: "Streaming source",
	error: "Playback error"
};

const buttons = [...document.querySelectorAll("[data-sound]")];
const soundLabels = [...document.querySelectorAll("[data-sound-label]")];
const announcement = document.querySelector("#announcement");
const audio = document.querySelector("#soundboard-audio");
const passwordModal = document.querySelector("#password-modal");
const passwordForm = document.querySelector("#password-form");
const passwordInput = document.querySelector("#password-input");
const passwordModalTitle = document.querySelector("#password-modal-title");
const passwordCancelButtons = [...document.querySelectorAll("[data-password-cancel]")];

const objectUrlById = new Map();
const warmupById = new Map();
const pressTimeoutById = new Map();
const lastPointerTriggerAtById = new Map();
let playbackToken = 0;
let activePasswordRequest = null;

function setAnnouncement(message) {
	if (announcement) {
		announcement.textContent = message;
	}
}

function getStatusElement(id) {
	return document.querySelector(`#${CSS.escape(id)}-status`);
}

function setStatus(id, status) {
	const statusElement = getStatusElement(id);
	if (!statusElement) {
		return;
	}

	statusElement.textContent = statusText[status];
	statusElement.className = `status-pill status-${status}`;
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

function rememberPointerTrigger(id) {
	if (!id) {
		return;
	}

	lastPointerTriggerAtById.set(id, performance.now());
}

function wasRecentlyTriggeredByPointer(id) {
	if (!id) {
		return false;
	}

	const lastTriggeredAt = lastPointerTriggerAtById.get(id);
	return typeof lastTriggeredAt === "number" &&
		performance.now() - lastTriggeredAt <= POINTER_CLICK_SUPPRESSION_MS;
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
		return Promise.resolve(window.prompt(`Enter the password for ${label}.`));
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
			cleanup(passwordInput.value);
		};

		const handleCancel = () => {
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

function readCacheMeta() {
	try {
		return JSON.parse(window.localStorage.getItem(CACHE_META_KEY) ?? "{}");
	} catch {
		return {};
	}
}

function writeCacheMeta(meta) {
	try {
		window.localStorage.setItem(CACHE_META_KEY, JSON.stringify(meta));
	} catch {
		// Ignore storage failures and fall back to uncapped browser behavior.
	}
}

function getCachedAt(sourceUrl) {
	const meta = readCacheMeta();
	const cachedAt = meta[sourceUrl];
	return typeof cachedAt === "number" ? cachedAt : 0;
}

function rememberCacheTimestamp(sourceUrl) {
	const meta = readCacheMeta();
	meta[sourceUrl] = Date.now();
	writeCacheMeta(meta);
}

function forgetCacheTimestamp(sourceUrl) {
	const meta = readCacheMeta();
	if (!(sourceUrl in meta)) {
		return;
	}

	delete meta[sourceUrl];
	writeCacheMeta(meta);
}

function isCacheFresh(sourceUrl) {
	const cachedAt = getCachedAt(sourceUrl);
	return cachedAt > 0 && Date.now() - cachedAt <= CACHE_TTL_MS;
}

async function purgeExpiredCacheEntry(id, sourceUrl) {
	forgetObjectUrl(id);
	forgetCacheTimestamp(sourceUrl);

	if ("caches" in window) {
		try {
			const cache = await caches.open(SOUND_CACHE_NAME);
			await cache.delete(sourceUrl);
		} catch {
			// Ignore cache cleanup failures.
		}
	}
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

async function restoreCachedSounds() {
	if (!("caches" in window)) {
		return;
	}

	try {
		const cache = await caches.open(SOUND_CACHE_NAME);

		await Promise.all(
			buttons.map(async (button) => {
				const id = button.dataset.id;
				const sourceUrl = button.dataset.url;

				if (!id || !sourceUrl || objectUrlById.has(id)) {
					return;
				}

				if (!isCacheFresh(sourceUrl)) {
					await purgeExpiredCacheEntry(id, sourceUrl);
					return;
				}

				const cachedResponse = await cache.match(sourceUrl);
				if (!cachedResponse || cachedResponse.type === "opaque") {
					return;
				}

				const blob = await cachedResponse.blob();
				if (!blob.size) {
					return;
				}

				rememberObjectUrl(id, URL.createObjectURL(blob));
				setStatus(id, "cached");
			})
		);
	} catch {
		// Keep direct playback available if cache hydration fails.
	}
}

async function warmSound(button) {
	const id = button.dataset.id;
	const sourceUrl = button.dataset.url;

	if (!id || !sourceUrl) {
		return;
	}

	if (objectUrlById.has(id) && isCacheFresh(sourceUrl)) {
		setStatus(id, "cached");
		return;
	}

	if (objectUrlById.has(id) && !isCacheFresh(sourceUrl)) {
		await purgeExpiredCacheEntry(id, sourceUrl);
	}

	const inFlightWarmup = warmupById.get(id);
	if (inFlightWarmup) {
		return inFlightWarmup;
	}

	const warmup = (async () => {
		try {
			if ("caches" in window) {
				const cache = await caches.open(SOUND_CACHE_NAME);
				const cachedResponse = await cache.match(sourceUrl);

				if (cachedResponse && !isCacheFresh(sourceUrl)) {
					await purgeExpiredCacheEntry(id, sourceUrl);
				}

				if (cachedResponse && cachedResponse.type !== "opaque" && isCacheFresh(sourceUrl)) {
					const cachedBlob = await cachedResponse.blob();
					if (cachedBlob.size) {
						rememberObjectUrl(id, URL.createObjectURL(cachedBlob));
						setStatus(id, "cached");
						return;
					}
				}
			}

			setStatus(id, "loading");

			const response = await fetch(sourceUrl, { mode: "cors" });
			if (!response.ok) {
				throw new Error(`Unexpected response ${response.status}`);
			}

			if ("caches" in window) {
				const cache = await caches.open(SOUND_CACHE_NAME);
				await cache.put(sourceUrl, response.clone());
			}

			const blob = await response.blob();
			if (!blob.size) {
				throw new Error("Received an empty audio file.");
			}

			rememberObjectUrl(id, URL.createObjectURL(blob));
			rememberCacheTimestamp(sourceUrl);
			setStatus(id, "cached");
		} catch {
			if (!objectUrlById.has(id)) {
				setStatus(id, "streamed");
			}
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

	if (!isCacheFresh(sourceUrl)) {
		await purgeExpiredCacheEntry(id, sourceUrl);
	}

	const playbackUrl = objectUrlById.get(id) ?? sourceUrl;
	const currentToken = ++playbackToken;

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
		setStatus(id, "error");
		setAnnouncement(`Playback for ${label} was blocked. Click the button again.`);
		return;
	}

	if (currentToken !== playbackToken) {
		stopCurrentPlayback();
		return;
	}

	if (objectUrlById.has(id)) {
		setStatus(id, "cached");
		setAnnouncement(`Playing ${label} from local cache.`);
		return;
	}

	setAnnouncement(`Playing ${label}. Warming a browser cache in the background.`);
	void warmSound(button).then(() => {
		if (objectUrlById.has(id)) {
			setAnnouncement(`${label} is cached locally for faster replays.`);
		}
	});
}

buttons.forEach((button) => {
	button.addEventListener("pointerdown", () => {
		const id = button.dataset.id;
		rememberPointerTrigger(id);
		void playButton(button);
	});

	button.addEventListener("click", (event) => {
		const id = button.dataset.id;
		if (event.detail !== 0 && wasRecentlyTriggeredByPointer(id)) {
			return;
		}

		void playButton(button);
	});
});

soundLabels.forEach((label) => {
	label.addEventListener("pointerdown", () => {
		const targetId = label.dataset.soundLabel;
		const button = buttons.find((candidate) => candidate.dataset.id === targetId);
		if (button) {
			rememberPointerTrigger(targetId);
			void playButton(button);
		}
	});

	label.addEventListener("click", (event) => {
		const targetId = label.dataset.soundLabel;
		if (event.detail !== 0 && wasRecentlyTriggeredByPointer(targetId)) {
			return;
		}

		const button = buttons.find((candidate) => candidate.dataset.id === targetId);
		if (button) {
			void playButton(button);
		}
	});
});

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

void restoreCachedSounds();
