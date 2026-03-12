import { buttonData } from "./buttons.js";
import { createHaptics } from "./haptics.js";

const SOUND_CACHE_NAME = "mathnasium-soundboard-v1";
const CACHE_META_KEY = "mathnasium-soundboard-cache-meta-v1";
const PLEASE_DONT_MODIFY_ME_THX_KEY = "please-dont-modify-me-thx";
const CACHE_TTL_MS = 60 * 60 * 1000;
const PASSWORD_COOLDOWN_MS = 5 * 60 * 1000;
const PASSWORD_ERROR_DURATION_MS = 450;
const PASSWORD_SUCCESS_DURATION_MS = 900;
const COOLDOWN_TICK_MS = 250;
const PRESS_DURATION_MS = 90;
const POINTER_CLICK_SUPPRESSION_MS = 400;
const COUNTDOWN_BUTTON_ID = "67";
const UNLOCK_COUNTDOWN_STEP_MS = 1750;
const COUNTDOWN_STEP_HAPTIC_PATTERN = [{ duration: 40, intensity: 1 }];
const COUNTDOWN_FINAL_HAPTIC_PATTERN = [{ duration: 120, intensity: 1 }];

const buttonGrid = document.querySelector(".instants");
const announcement = document.querySelector("#announcement");
const audio = document.querySelector("#soundboard-audio");
const passwordModal = document.querySelector("#password-modal");
const passwordModalPanel = document.querySelector(".password-modal-panel");
const passwordForm = document.querySelector("#password-form");
const passwordInput = document.querySelector("#password-input");
const passwordModalTitle = document.querySelector("#password-modal-title");
const passwordCancelButtons = [...document.querySelectorAll("[data-password-cancel]")];
const unlockCountdown = document.querySelector("#unlock-countdown");
const unlockCountdownStage = document.querySelector(".unlock-countdown-stage");
const unlockCountdownNumber = document.querySelector("#unlock-countdown-number");
const labelCollator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base"
});
const haptics = createHaptics();

const objectUrlById = new Map();
const warmupById = new Map();
const pressTimeoutById = new Map();
let buttons = [];
let playbackToken = 0;
let activePasswordRequest = null;
let cacheMeta = null;
let pleaseDontModifyMeThx = null;
let soundCachePromise = null;
let cooldownIntervalId = null;
let activeUnlockCountdown = null;
let lastPointerPress = null;
let lastPointerActivation = null;

function triggerPressHaptic() {
	void haptics.trigger("success");
}

function isUnlockCountdownVisible() {
	return Boolean(unlockCountdown && !unlockCountdown.hidden);
}

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

	const cooldownOverlay = document.createElement("div");
	cooldownOverlay.className = "button-cooldown-overlay";
	cooldownOverlay.hidden = true;
	cooldownOverlay.setAttribute("aria-hidden", "true");

	const cooldownTimer = document.createElement("span");
	cooldownTimer.className = "button-cooldown-timer";
	cooldownOverlay.append(cooldownTimer);

	const shadow = document.createElement("div");
	shadow.className = "small-button-shadow";
	shadow.setAttribute("aria-hidden", "true");

	const label = document.createElement("span");
	label.className = "instant-link";
	label.textContent = entry.label;

	article.append(background, button, cooldownOverlay, shadow, label);
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

function getPleaseDontModifyMeThx() {
	if (pleaseDontModifyMeThx) {
		return pleaseDontModifyMeThx;
	}

	try {
		pleaseDontModifyMeThx = JSON.parse(window.localStorage.getItem(PLEASE_DONT_MODIFY_ME_THX_KEY) ?? "{}");
	} catch {
		pleaseDontModifyMeThx = {};
	}

	return pleaseDontModifyMeThx;
}

function persistPleaseDontModifyMeThx() {
	try {
		window.localStorage.setItem(PLEASE_DONT_MODIFY_ME_THX_KEY, JSON.stringify(getPleaseDontModifyMeThx()));
	} catch {
		// Ignore storage failures and fall back to uncapped browser behavior.
	}
}

function getButtonCooldownExpiresAt(id) {
	const expiresAt = getPleaseDontModifyMeThx()[id];
	return typeof expiresAt === "number" ? expiresAt : 0;
}

function setButtonCooldown(id, expiresAt) {
	const cooldowns = getPleaseDontModifyMeThx();
	cooldowns[id] = expiresAt;
	persistPleaseDontModifyMeThx();
}

function clearButtonCooldown(id) {
	const cooldowns = getPleaseDontModifyMeThx();
	if (!(id in cooldowns)) {
		return;
	}

	delete cooldowns[id];
	persistPleaseDontModifyMeThx();
}

function getButtonCooldownRemainingMs(id) {
	const expiresAt = getButtonCooldownExpiresAt(id);
	if (!expiresAt) {
		clearButtonCooldown(id);
		return 0;
	}

	const remainingMs = expiresAt - Date.now();
	if (remainingMs > 0) {
		return remainingMs;
	}

	clearButtonCooldown(id);
	return 0;
}

function formatCooldownRemaining(ms) {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getCooldownElements(button) {
	const instant = button.closest(".instant");
	if (!(instant instanceof HTMLElement)) {
		return {
			instant: null,
			overlay: null,
			timer: null
		};
	}

	const overlay = instant.querySelector(".button-cooldown-overlay");
	const timer = overlay?.querySelector(".button-cooldown-timer");

	return {
		instant,
		overlay: overlay instanceof HTMLElement ? overlay : null,
		timer: timer instanceof HTMLElement ? timer : null
	};
}

function updateButtonCooldownState(button) {
	const id = button.dataset.id;
	if (!id) {
		return 0;
	}

	const remainingMs = getButtonCooldownRemainingMs(id);
	const isLocked = remainingMs > 0;
	const { instant, overlay, timer } = getCooldownElements(button);

	if (instant) {
		instant.classList.toggle("is-locked", isLocked);
	}

	button.disabled = isLocked;
	if (isLocked) {
		button.setAttribute("aria-disabled", "true");
	} else {
		button.removeAttribute("aria-disabled");
	}

	if (overlay) {
		overlay.hidden = !isLocked;
	}

	if (timer) {
		timer.textContent = isLocked ? formatCooldownRemaining(remainingMs) : "";
	}

	return remainingMs;
}

function syncCooldownTicker(hasLockedButtons) {
	if (hasLockedButtons) {
		if (cooldownIntervalId === null) {
			cooldownIntervalId = window.setInterval(updateAllButtonCooldownStates, COOLDOWN_TICK_MS);
		}
		return;
	}

	if (cooldownIntervalId !== null) {
		window.clearInterval(cooldownIntervalId);
		cooldownIntervalId = null;
	}
}

function updateAllButtonCooldownStates() {
	let hasLockedButtons = false;

	buttons.forEach((button) => {
		if (updateButtonCooldownState(button) > 0) {
			hasLockedButtons = true;
		}
	});

	syncCooldownTicker(hasLockedButtons);
}

function startButtonCooldown(button) {
	const id = button.dataset.id;
	if (!id) {
		return;
	}

	setButtonCooldown(id, Date.now() + PASSWORD_COOLDOWN_MS);
	updateAllButtonCooldownStates();
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

function wait(ms) {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

function hasPreparedAudioSource(sourceUrl) {
	return Boolean(audio && sourceUrl && audio.getAttribute("src") === sourceUrl);
}

function prepareAudioElementSource(sourceUrl) {
	if (!audio || !sourceUrl) {
		return;
	}

	audio.preload = "auto";

	if (audio.getAttribute("src") === sourceUrl) {
		return;
	}

	audio.src = sourceUrl;
	audio.load();
}

function rememberPointerPress(button) {
	const id = button.dataset.id;
	if (!id) {
		return;
	}

	lastPointerPress = {
		buttonId: id,
		timestamp: Date.now()
	};
}

function rememberPointerActivation(button) {
	const id = button.dataset.id;
	if (!id) {
		return;
	}

	lastPointerActivation = {
		buttonId: id,
		timestamp: Date.now()
	};
}

function hasRecentPointerRecord(button, record) {
	const id = button.dataset.id;
	if (!id || !record || record.buttonId !== id) {
		return false;
	}

	return Date.now() - record.timestamp <= POINTER_CLICK_SUPPRESSION_MS;
}

function handleUnlockCountdownKeydown(event) {
	if (!isUnlockCountdownVisible() || event.metaKey || event.ctrlKey || event.altKey) {
		return;
	}

	event.preventDefault();
	event.stopImmediatePropagation();
}

function resetUnlockCountdownUi() {
	document.body.classList.remove("is-countdown-active");
	document.removeEventListener("keydown", handleUnlockCountdownKeydown, true);

	if (unlockCountdown) {
		unlockCountdown.hidden = true;
		unlockCountdown.removeAttribute("data-count");
	}

	if (unlockCountdownStage) {
		unlockCountdownStage.classList.remove("is-beat");
	}

	if (unlockCountdownNumber) {
		unlockCountdownNumber.textContent = "3";
	}
}

function showUnlockCountdownStep(count) {
	if (!unlockCountdown || !unlockCountdownStage || !unlockCountdownNumber) {
		return;
	}

	unlockCountdown.hidden = false;
	unlockCountdown.dataset.count = String(count);
	unlockCountdownNumber.textContent = String(count);
	unlockCountdownStage.classList.remove("is-beat");
	void unlockCountdownStage.offsetWidth;
	unlockCountdownStage.classList.add("is-beat");
}

function showUnlockCountdownFinal(value) {
	if (!unlockCountdown || !unlockCountdownStage || !unlockCountdownNumber) {
		return;
	}

	unlockCountdown.hidden = false;
	unlockCountdown.dataset.count = String(value);
	unlockCountdownNumber.textContent = String(value);
	unlockCountdownStage.classList.remove("is-beat");
}

async function startUnlockCountdown(button) {
	const label = button.dataset.label ?? "this sound";
	const sourceUrl = button.dataset.url;

	if (activeUnlockCountdown) {
		return false;
	}

	activeUnlockCountdown = (async () => {
		playbackToken += 1;
		stopCurrentPlayback({ preserveSequence: true });
		prepareAudioElementSource(sourceUrl);
		document.body.classList.add("is-countdown-active");
		document.addEventListener("keydown", handleUnlockCountdownKeydown, true);

		for (const count of [3, 2, 1]) {
			showUnlockCountdownStep(count);
			void haptics.startSequence(COUNTDOWN_STEP_HAPTIC_PATTERN);
			setAnnouncement(count === 3 ? `${label} unlocked. 3.` : `${count}.`);
			await wait(UNLOCK_COUNTDOWN_STEP_MS);
		}

		showUnlockCountdownFinal(label);
		void haptics.startSequence(COUNTDOWN_FINAL_HAPTIC_PATTERN);
	})().finally(() => {
		activeUnlockCountdown = null;
	});

	await activeUnlockCountdown;
	return true;
}

function resetPasswordModalState(label) {
	if (passwordModalTitle) {
		passwordModalTitle.textContent = `Enter password for ${label} button`;
		passwordModalTitle.classList.remove("is-error");
	}

	if (passwordInput) {
		passwordInput.value = "";
		passwordInput.disabled = false;
		passwordInput.classList.remove("is-error");
	}

	if (passwordModalPanel) {
		passwordModalPanel.classList.remove("is-shaking");
	}
}

function showIncorrectPasswordState() {
	if (passwordModalTitle) {
		passwordModalTitle.textContent = "Incorrect";
		passwordModalTitle.classList.add("is-error");
	}

	if (passwordInput) {
		passwordInput.disabled = true;
		passwordInput.classList.add("is-error");
	}

	if (passwordModalPanel) {
		passwordModalPanel.classList.remove("is-shaking");
		void passwordModalPanel.offsetWidth;
		passwordModalPanel.classList.add("is-shaking");
	}
}

function showAcceptedPasswordState(message) {
	if (passwordModalTitle) {
		passwordModalTitle.textContent = message;
		passwordModalTitle.classList.remove("is-error");
	}

	if (passwordInput) {
		passwordInput.disabled = true;
		passwordInput.classList.remove("is-error");
	}

	if (passwordModalPanel) {
		passwordModalPanel.classList.remove("is-shaking");
	}
}

async function ensureButtonAccess(button) {
	const id = button.dataset.id;
	const label = button.dataset.label ?? "this sound";
	const password = button.dataset.password;

	if (!password) {
		return true;
	}

	if (id) {
		const remainingMs = getButtonCooldownRemainingMs(id);
		if (remainingMs > 0) {
			updateButtonCooldownState(button);
			setAnnouncement(`${label} is locked for ${formatCooldownRemaining(remainingMs)}.`);
			return false;
		}
	}

	const passwordResult = await requestPassword(button);
	if (passwordResult === "cancelled") {
		setAnnouncement(`${label} cancelled.`);
		return false;
	}

	if (passwordResult === "incorrect") {
		startButtonCooldown(button);
		setAnnouncement(`Incorrect password for ${label}. Try again in ${formatCooldownRemaining(PASSWORD_COOLDOWN_MS)}.`);
		return false;
	}

	if (id !== COUNTDOWN_BUTTON_ID) {
		setAnnouncement(`Password accepted for ${label}.`);
	}

	return true;
}

function requestPassword(button) {
	const label = button.dataset.label ?? "this sound";
	const id = button.dataset.id;
	const expectedPassword = button.dataset.password;

	if (!passwordModal || !passwordModalPanel || !passwordForm || !passwordInput || !passwordModalTitle || !expectedPassword) {
		setAnnouncement(`Password dialog unavailable for ${label}.`);
		return Promise.resolve("cancelled");
	}

	if (activePasswordRequest) {
		return activePasswordRequest.promise;
	}

	passwordModal.hidden = false;
	resetPasswordModalState(label);

	const promise = new Promise((resolve) => {
		activePasswordRequest = { resolve, promise: null };
		let feedbackTimeout = 0;
		let isSettling = false;

		const cleanup = (value) => {
			if (feedbackTimeout) {
				window.clearTimeout(feedbackTimeout);
			}

			passwordModal.hidden = true;
			resetPasswordModalState(label);
			passwordForm.removeEventListener("submit", handleSubmit);
			passwordCancelButtons.forEach((cancelButton) => {
				cancelButton.removeEventListener("click", handleCancel);
			});
			document.removeEventListener("keydown", handleKeyDown);
			activePasswordRequest = null;
			resolve(value);
		};

		const handleSubmit = (event) => {
			event.preventDefault();
			event.stopPropagation();

			if (isSettling) {
				return;
			}

			if (passwordInput.value === expectedPassword) {
				if (id === COUNTDOWN_BUTTON_ID) {
					isSettling = true;
					void warmSound(button);
					showAcceptedPasswordState("Correct. God help us");
					setAnnouncement("Correct. God help us");
					feedbackTimeout = window.setTimeout(() => {
						cleanup("accepted");
					}, PASSWORD_SUCCESS_DURATION_MS);
					return;
				}

				triggerPressHaptic();
				cleanup("accepted");
				return;
			}

			isSettling = true;
			void haptics.trigger("error");
			showIncorrectPasswordState();
			feedbackTimeout = window.setTimeout(() => {
				cleanup("incorrect");
			}, PASSWORD_ERROR_DURATION_MS);
		};

		const handleCancel = (event) => {
			event.preventDefault();
			event.stopPropagation();

			if (isSettling) {
				return;
			}

			cleanup("cancelled");
		};

		const handleKeyDown = (event) => {
			if (event.key !== "Escape") {
				return;
			}

			event.preventDefault();

			if (isSettling) {
				return;
			}

			cleanup("cancelled");
		};

		passwordForm.addEventListener("submit", handleSubmit);
		passwordCancelButtons.forEach((cancelButton) => {
			cancelButton.addEventListener("click", handleCancel);
		});
		document.addEventListener("keydown", handleKeyDown);
		window.setTimeout(() => passwordInput.focus(), 0);
	});

	activePasswordRequest.promise = promise;
	return promise;
}

function stopCurrentPlayback({ preserveSequence = false, preserveSource = false } = {}) {
	if (!audio) {
		return;
	}

	haptics.stopLoop();
	if (!preserveSequence) {
		haptics.stopSequence();
	}

	if (audio.dataset.activeId === COUNTDOWN_BUTTON_ID) {
		resetUnlockCountdownUi();
	}

	delete audio.dataset.activeId;
	audio.pause();
	audio.currentTime = 0;
	if (!preserveSource) {
		audio.removeAttribute("src");
		audio.load();
	}
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

async function playButton(button, { shouldPulse = true } = {}) {
	const id = button.dataset.id;
	const label = button.dataset.label;
	const sourceUrl = button.dataset.url;

	if (!audio || !id || !label || !sourceUrl || isUnlockCountdownVisible()) {
		return;
	}

	if (id !== COUNTDOWN_BUTTON_ID) {
		triggerPressHaptic();
	}

	const hasAccess = await ensureButtonAccess(button);
	if (!hasAccess) {
		return;
	}

	const countdownWarmupPromise = id === COUNTDOWN_BUTTON_ID && button.dataset.password ? warmSound(button) : null;

	if (id === COUNTDOWN_BUTTON_ID && button.dataset.password) {
		const countdownCompleted = await startUnlockCountdown(button);
		if (!countdownCompleted) {
			return;
		}
	}

	if (activeUnlockCountdown) {
		return;
	}

	if (shouldPulse) {
		pulseButton(button);
	}

	const currentToken = ++playbackToken;
	const shouldUsePreparedCountdownAudio = id === COUNTDOWN_BUTTON_ID && hasPreparedAudioSource(sourceUrl);
	let resolvedCachedObjectUrl = null;
	let playbackUrl = sourceUrl;

	if (!shouldUsePreparedCountdownAudio) {
		const cachedObjectUrl = countdownWarmupPromise ?? getCachedObjectUrl(id, sourceUrl);
		resolvedCachedObjectUrl = await cachedObjectUrl;
		if (currentToken !== playbackToken) {
			return;
		}

		playbackUrl = resolvedCachedObjectUrl ?? sourceUrl;
	}

	try {
		stopCurrentPlayback({
			preserveSequence: id === COUNTDOWN_BUTTON_ID,
			preserveSource: shouldUsePreparedCountdownAudio
		});
		audio.dataset.activeId = id;
		if (!shouldUsePreparedCountdownAudio) {
			audio.src = playbackUrl;
		}
		button.classList.add("is-playing");
		await audio.play();
	} catch {
		if (currentToken !== playbackToken) {
			return;
		}

		delete audio.dataset.activeId;
		if (id === COUNTDOWN_BUTTON_ID) {
			haptics.stopSequence();
			resetUnlockCountdownUi();
		}

		button.classList.remove("is-playing");
		setAnnouncement(`Playback for ${label} was blocked. Click the button again.`);
		return;
	}

	if (currentToken !== playbackToken) {
		stopCurrentPlayback();
		return;
	}

	if (id === COUNTDOWN_BUTTON_ID) {
		if (!resolvedCachedObjectUrl && !countdownWarmupPromise) {
			void warmSound(button);
		}

		setAnnouncement(`Playing ${label}.`);
		return;
	}

	if (resolvedCachedObjectUrl) {
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
		if (isUnlockCountdownVisible()) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		const button = getButtonFromEventTarget(event.target);
		if (!button) {
			return;
		}

		rememberPointerPress(button);

		if (haptics.requiresClickGesture) {
			return;
		}

		if (button.dataset.password) {
			return;
		}

		rememberPointerActivation(button);
		void playButton(button, { shouldPulse: false });
	});

	buttonGrid.addEventListener("click", (event) => {
		if (isUnlockCountdownVisible()) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		const button = getButtonFromEventTarget(event.target);
		if (!button) {
			return;
		}

		if (hasRecentPointerRecord(button, lastPointerActivation)) {
			return;
		}

		void playButton(button, {
			shouldPulse: !hasRecentPointerRecord(button, lastPointerPress)
		});
	});
}

buttons = renderButtons(buttonData);
bindButtonInteractions();
updateAllButtonCooldownStates();

if (audio) {
	audio.addEventListener("ended", () => {
		haptics.stopLoop();
		haptics.stopSequence();
		buttons.forEach((button) => button.classList.remove("is-playing"));
		if (audio.dataset.activeId === COUNTDOWN_BUTTON_ID) {
			resetUnlockCountdownUi();
		}
		delete audio.dataset.activeId;
	});
}

window.addEventListener("beforeunload", () => {
	stopCurrentPlayback();

	for (const timeout of pressTimeoutById.values()) {
		window.clearTimeout(timeout);
	}

	if (cooldownIntervalId !== null) {
		window.clearInterval(cooldownIntervalId);
	}

	resetUnlockCountdownUi();
	haptics.destroy();

	for (const objectUrl of objectUrlById.values()) {
		URL.revokeObjectURL(objectUrl);
	}
});
