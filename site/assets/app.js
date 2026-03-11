const SOUND_CACHE_NAME = "mathnasium-soundboard-v1";
const PRESS_DURATION_MS = 170;

const statusText = {
	idle: "Ready",
	loading: "Caching...",
	cached: "Cached locally",
	streamed: "Streaming source",
	error: "Playback error"
};

const buttons = [...document.querySelectorAll("[data-sound]")];
const announcement = document.querySelector("#announcement");
const audio = document.querySelector("#soundboard-audio");

const objectUrlById = new Map();
const warmupById = new Map();
const pressTimeoutById = new Map();

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

	button.classList.add("pressed");

	const timeout = window.setTimeout(() => {
		button.classList.remove("pressed");
		pressTimeoutById.delete(id);
	}, PRESS_DURATION_MS);

	pressTimeoutById.set(id, timeout);
}

function rememberObjectUrl(id, objectUrl) {
	const existingObjectUrl = objectUrlById.get(id);
	if (existingObjectUrl) {
		URL.revokeObjectURL(existingObjectUrl);
	}

	objectUrlById.set(id, objectUrl);
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

	if (objectUrlById.has(id)) {
		setStatus(id, "cached");
		return;
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

				if (cachedResponse && cachedResponse.type !== "opaque") {
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

	pulseButton(button);

	const playbackUrl = objectUrlById.get(id) ?? sourceUrl;

	try {
		audio.pause();
		buttons.forEach((candidate) => candidate.classList.remove("is-playing"));
		audio.src = playbackUrl;
		audio.currentTime = 0;
		button.classList.add("is-playing");
		await audio.play();
	} catch {
		button.classList.remove("is-playing");
		setStatus(id, "error");
		setAnnouncement(`Playback for ${label} was blocked. Click the button again.`);
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
	button.addEventListener("pointerdown", () => pulseButton(button));
	button.addEventListener("click", () => {
		void playButton(button);
	});
});

if (audio) {
	audio.addEventListener("ended", () => {
		buttons.forEach((button) => button.classList.remove("is-playing"));
	});
}

window.addEventListener("beforeunload", () => {
	for (const timeout of pressTimeoutById.values()) {
		window.clearTimeout(timeout);
	}

	for (const objectUrl of objectUrlById.values()) {
		URL.revokeObjectURL(objectUrl);
	}
});

void restoreCachedSounds();
