/**
 * Optional spoken replies, behind a toggle that starts off.
 *
 * Only `speechSynthesis` (text to speech) is used, and only for the
 * assistant's own lines and the refusal text. Speech *recognition* is
 * deliberately not offered: in Chromium it streams the microphone to a
 * vendor's cloud service, which would quietly break this demo's
 * "runs with the network off" property. Typed input stays primary.
 */
export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance === "function";
}

export function speak(text: string): void {
  if (!speechSupported()) return;
  const utterance = new SpeechSynthesisUtterance(text.replace(/[•×]/g, " "));
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}
