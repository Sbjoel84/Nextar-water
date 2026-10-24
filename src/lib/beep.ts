// A short two-tone alert made with the Web Audio API (no sound file needed).
//
// Browsers only let a page play sound after the user has interacted with it,
// so the AudioContext is created/resumed on the first click or key press;
// beeps before that are silently skipped.

let ctx: AudioContext | null = null;

function getContext() {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/** Call once on mount: unlocks audio on the user's first interaction. */
export function unlockAudioOnInteraction() {
  const unlock = () => {
    getContext()
      ?.resume()
      .catch(() => {});
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return unlock;
}

export function beep() {
  const ac = getContext();
  if (!ac || ac.state !== "running") return;
  const start = ac.currentTime;
  for (const [offset, freq] of [
    [0, 880],
    [0.18, 1175],
  ] as const) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = start + offset;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.16);
  }
}
