const DEFAULT_INTENSITY = 0.5;
const TOGGLE_MIN_MS = 16;
const TOGGLE_MAX_MS = 184;

const PRESETS = {
	success: [
		{ duration: 30, intensity: 0.5 },
		{ delay: 60, duration: 40, intensity: 1 }
	],
	error: [
		{ duration: 40, intensity: 0.7 },
		{ delay: 40, duration: 40, intensity: 0.7 },
		{ delay: 40, duration: 40, intensity: 0.9 },
		{ delay: 40, duration: 50, intensity: 0.6 }
	],
	buzz: [{ duration: 1000, intensity: 1 }]
};

const supportsVibration = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

function clampIntensity(value) {
	return Math.max(0, Math.min(1, value));
}

function clonePattern(name) {
	const pattern = PRESETS[name];
	return pattern ? pattern.map((entry) => ({ ...entry })) : null;
}

function getPatternDuration(pattern) {
	return pattern.reduce((total, entry) => total + (entry.delay ?? 0) + entry.duration, 0);
}

function modulateVibration(duration, intensity) {
	if (intensity >= 1) {
		return [duration];
	}

	if (intensity <= 0) {
		return [];
	}

	const onTime = Math.max(1, Math.round(20 * intensity));
	const offTime = 20 - onTime;
	const segments = [];
	let remaining = duration;

	while (remaining >= 20) {
		segments.push(onTime);
		segments.push(offTime);
		remaining -= 20;
	}

	if (remaining > 0) {
		const remainingOnTime = Math.max(1, Math.round(remaining * intensity));
		segments.push(remainingOnTime);

		const remainingOffTime = remaining - remainingOnTime;
		if (remainingOffTime > 0) {
			segments.push(remainingOffTime);
		}
	}

	return segments;
}

function toVibrationPattern(pattern) {
	const segments = [];

	for (const entry of pattern) {
		const intensity = clampIntensity(entry.intensity ?? DEFAULT_INTENSITY);
		const delay = entry.delay ?? 0;

		if (delay > 0) {
			if (segments.length > 0 && segments.length % 2 === 0) {
				segments[segments.length - 1] += delay;
			} else {
				if (segments.length === 0) {
					segments.push(0);
				}

				segments.push(delay);
			}
		}

		const modulated = modulateVibration(entry.duration, intensity);
		if (modulated.length === 0) {
			if (segments.length > 0 && segments.length % 2 === 0) {
				segments[segments.length - 1] += entry.duration;
			} else if (entry.duration > 0) {
				segments.push(0, entry.duration);
			}
			continue;
		}

		segments.push(...modulated);
	}

	return segments;
}

export function createHaptics() {
	let fallbackLabel = null;
	let fallbackFrameId = 0;
	let fallbackResolve = null;
	let loopTimeoutId = 0;
	let loopToken = 0;
	let currentPatternOwner = null;
	let currentPatternId = 0;
	let vibrationResetTimeoutId = 0;

	function ensureFallbackControl() {
		if (fallbackLabel || typeof document === "undefined" || !document.body) {
			return;
		}

		const id = `soundboard-haptics-${Math.random().toString(36).slice(2)}`;
		const label = document.createElement("label");
		label.setAttribute("for", id);
		label.setAttribute("aria-hidden", "true");
		label.style.position = "fixed";
		label.style.left = "-100vw";
		label.style.top = "-100vh";
		label.style.width = "1px";
		label.style.height = "1px";
		label.style.overflow = "hidden";
		label.style.opacity = "0";
		label.style.pointerEvents = "none";
		label.style.userSelect = "none";
		label.textContent = "Haptic feedback";

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.id = id;
		checkbox.tabIndex = -1;
		checkbox.setAttribute("switch", "");
		checkbox.setAttribute("aria-hidden", "true");
		checkbox.style.appearance = "auto";

		label.append(checkbox);
		document.body.append(label);
		fallbackLabel = label;
	}

	function clearCurrentPattern(owner = null) {
		if (owner && currentPatternOwner !== owner) {
			return;
		}

		currentPatternId += 1;

		if (fallbackFrameId) {
			window.cancelAnimationFrame(fallbackFrameId);
			fallbackFrameId = 0;
		}

		if (vibrationResetTimeoutId) {
			window.clearTimeout(vibrationResetTimeoutId);
			vibrationResetTimeoutId = 0;
		}

		if (supportsVibration && currentPatternOwner) {
			navigator.vibrate(0);
		}

		if (fallbackResolve) {
			const resolve = fallbackResolve;
			fallbackResolve = null;
			resolve();
		}

		currentPatternOwner = null;
	}

	function runFallbackPattern(pattern, owner) {
		ensureFallbackControl();
		if (!fallbackLabel) {
			return Promise.resolve();
		}

		const patternId = currentPatternId;
		const phases = [];
		let cumulative = 0;

		for (const entry of pattern) {
			const intensity = clampIntensity(entry.intensity ?? DEFAULT_INTENSITY);
			const delay = entry.delay ?? 0;

			if (delay > 0) {
				cumulative += delay;
				phases.push({ end: cumulative, isOn: false, intensity: 0 });
			}

			cumulative += entry.duration;
			phases.push({ end: cumulative, isOn: true, intensity });
		}

		const totalDuration = cumulative;
		if (totalDuration <= 0) {
			currentPatternOwner = null;
			return Promise.resolve();
		}

		return new Promise((resolve) => {
			let startTime = window.performance.now();
			let lastToggleTime = -1;

			fallbackResolve = resolve;

			if ((pattern[0]?.delay ?? 0) === 0) {
				fallbackLabel.click();
				lastToggleTime = startTime;
			}

			const step = (timestamp) => {
				if (patternId !== currentPatternId || currentPatternOwner !== owner) {
					fallbackFrameId = 0;
					if (fallbackResolve === resolve) {
						fallbackResolve = null;
					}
					resolve();
					return;
				}

				const elapsed = timestamp - startTime;
				if (elapsed >= totalDuration) {
					fallbackFrameId = 0;
					if (fallbackResolve === resolve) {
						fallbackResolve = null;
					}

					if (patternId === currentPatternId && currentPatternOwner === owner) {
						currentPatternOwner = null;
					}

					resolve();
					return;
				}

				let phase = phases[0];
				for (const candidate of phases) {
					if (elapsed < candidate.end) {
						phase = candidate;
						break;
					}
				}

				if (phase?.isOn) {
					const toggleInterval = TOGGLE_MIN_MS + (1 - phase.intensity) * TOGGLE_MAX_MS;
					if (lastToggleTime === -1 || timestamp - lastToggleTime >= toggleInterval) {
						fallbackLabel.click();
						lastToggleTime = timestamp;
					}
				}

				fallbackFrameId = window.requestAnimationFrame(step);
			};

			fallbackFrameId = window.requestAnimationFrame(step);
		});
	}

	function playPattern(pattern, owner) {
		if (!pattern || pattern.length === 0) {
			return Promise.resolve();
		}

		clearCurrentPattern();
		currentPatternOwner = owner;
		const patternId = currentPatternId;
		const duration = getPatternDuration(pattern);

		if (supportsVibration) {
			navigator.vibrate(toVibrationPattern(pattern));

			if (duration > 0) {
				vibrationResetTimeoutId = window.setTimeout(() => {
					if (patternId === currentPatternId && currentPatternOwner === owner) {
						currentPatternOwner = null;
						vibrationResetTimeoutId = 0;
					}
				}, duration);
			}

			return Promise.resolve();
		}

		return runFallbackPattern(pattern, owner);
	}

	function stopLoop() {
		loopToken += 1;

		if (loopTimeoutId) {
			window.clearTimeout(loopTimeoutId);
			loopTimeoutId = 0;
		}

		clearCurrentPattern("loop");
	}

	return {
		requiresClickGesture: !supportsVibration,
		trigger(name) {
			const pattern = clonePattern(name);
			if (!pattern) {
				return Promise.resolve();
			}

			stopLoop();
			return playPattern(pattern, "one-shot");
		},
		startLoop(name) {
			const pattern = clonePattern(name);
			if (!pattern) {
				return;
			}

			stopLoop();

			const duration = Math.max(getPatternDuration(pattern), 16);
			const token = ++loopToken;

			const run = () => {
				if (token !== loopToken) {
					return;
				}

				void playPattern(clonePattern(name), "loop");
				loopTimeoutId = window.setTimeout(run, duration);
			};

			run();
		},
		stopLoop,
		cancel() {
			stopLoop();
			clearCurrentPattern();
		},
		destroy() {
			this.cancel();

			if (fallbackLabel) {
				fallbackLabel.remove();
				fallbackLabel = null;
			}
		}
	};
}
