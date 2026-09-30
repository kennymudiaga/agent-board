# Sprint 2 — Progress

> Updated continuously by the dev team during the sprint. Final handoff in `done.md`.

## 2026-09-30 — Session start

- **Branch:** `feature/sprint-2` (single branch/PR for the sprint, same model as sprint 1 — the plan's per-task PRs folded into one PR referencing issues #12–#19; noted as a deviation, as before).
- **T1 (true cursor watermark, #12) — done:**
  - Root cause: client-side `Math.max`-over-batch watermark can skip a message claimed by a *crashed previous run* — the client can't know it exists.
  - **Design decision (deviation from the plan's design note):** instead of client-side non-finalized tracking (which cannot see crashed-run claims), the **server** computes the true per-reader watermark: `min(seq of messages addressed to the reader that are pending or claimed-by-them, seq > since) - 1`, returned as `watermark` on every pickup response (spec §5.4/§6.2). Clients resume from `watermark`. This is the only way to be correct across crashes; the CLI keeps the in-process `seen` set purely for re-print suppression.
  - `readerWatermark(board, reader, since, now)` in db.ts: messages claimed by *another* reader (role/broadcast race) or terminal or not-their-mail never block.
  - CLI `cmdRead` persists `data.watermark`; falls back to old behavior if absent (older server).
  - Tests: 4 server watermark tests (blocking semantics, role race, not-my-mail, finalization advances) + CLI end-to-end #12 regression (claim msg_5 → crash → msg_6 arrives and is finalized → lease expiry → msg_5 redelivered, attempts=2). **37/37 green.**
- **Next:** T2 broadcast fan-out (deliveries table).