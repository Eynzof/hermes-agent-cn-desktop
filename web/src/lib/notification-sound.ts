import approvalBubble from "@/assets/sounds/approval-bubble.mp3"
import approvalConfirmation from "@/assets/sounds/approval-confirmation.mp3"
import approvalHint from "@/assets/sounds/approval-hint.mp3"
import approvalPop from "@/assets/sounds/approval-pop.mp3"
import completeBell from "@/assets/sounds/complete-bell.mp3"
import completeCorrect from "@/assets/sounds/complete-correct.mp3"
import completeHappyBells from "@/assets/sounds/complete-happy-bells.mp3"
import completePositive from "@/assets/sounds/complete-positive.mp3"

export const COMPLETE_SOUNDS = {
  correct: { label: "答对音", src: completeCorrect },
  positive: { label: "上升音", src: completePositive },
  bell: { label: "铃声", src: completeBell },
  happyBells: { label: "愉快铃声", src: completeHappyBells },
} as const

export type CompleteSoundId = keyof typeof COMPLETE_SOUNDS

export const APPROVAL_SOUNDS = {
  hint: { label: "提示音", src: approvalHint },
  pop: { label: "弹出音", src: approvalPop },
  bubble: { label: "气泡音", src: approvalBubble },
  confirmation: { label: "确认音", src: approvalConfirmation },
} as const

export type ApprovalSoundId = keyof typeof APPROVAL_SOUNDS

const audioCache = new Map<string, HTMLAudioElement>()

function getAudio(src: string): HTMLAudioElement {
  let audio = audioCache.get(src)
  if (!audio) {
    audio = new Audio(src)
    audio.volume = 0.5
    audioCache.set(src, audio)
  } else {
    audio.currentTime = 0
  }
  return audio
}

export function playNotificationSound(type: "complete" | "approval", soundId: string) {
  if (document.hasFocus()) return
  const sounds = type === "complete" ? COMPLETE_SOUNDS : APPROVAL_SOUNDS
  const entry = sounds[soundId as keyof typeof sounds]
  if (!entry) return
  const audio = getAudio(entry.src)
  audio.play().catch(() => {})
}

export function previewSound(type: "complete" | "approval", soundId: string) {
  const sounds = type === "complete" ? COMPLETE_SOUNDS : APPROVAL_SOUNDS
  const entry = sounds[soundId as keyof typeof sounds]
  if (!entry) return
  const audio = getAudio(entry.src)
  audio.play().catch(() => {})
}
