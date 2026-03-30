# 🧪 REPLAY ENGINE — STABILITY CHECKLIST

Test each scenario **exactly as written**. If anything feels wrong, note it.

---

## 🎬 SECTION 1: REPLAY ENGINE FLOWS

### Test 1.1: Enter Replay
- [ ] Click **Replay** button
- [ ] Verify: Chart does NOT update with new live candles
- [ ] Verify: Chart shows current data (not blank, not old)

### Test 1.2: Step Forward (one candle)
- [ ] Click **▶** (forward arrow)
- [ ] Verify: Exactly ONE candle appears
- [ ] Verify: No glitches, no flicker
- [ ] Click **▶** again → one more candle appears
- [ ] Repeat 5 times → smooth progression

### Test 1.3: Step Backward (one candle)
- [ ] Click **◀** (back arrow)
- [ ] Verify: Last candle disappears
- [ ] Verify: Smooth, no jitter
- [ ] Repeat 5 times → no crashes

### Test 1.4: Reset to Start
- [ ] Click **Reset**
- [ ] Verify: Jumps to initial candle
- [ ] Verify: Not blank, not too far ahead

### Test 1.5: Exit Replay
- [ ] Click **Stop** to exit replay
- [ ] Verify: Live stream RESUMES immediately
- [ ] Verify: New candles appear within 2-3 seconds
- [ ] Verify: No ghost data from replay

---

## ⚠️ SECTION 2: EDGE CASES

### Test 2.1: Spam Forward Button
- [ ] Enter replay
- [ ] **Frantically click ▶** 20+ times rapidly
- [ ] Verify: No crash
- [ ] Verify: No lag
- [ ] Verify: Stops at last candle (doesn't go past)

### Test 2.2: Spam Backward Button
- [ ] **Frantically click ◀** 20+ times
- [ ] Verify: No crash
- [ ] Verify: Stops at first candle (doesn't go negative)

### Test 2.3: Mix Forward/Backward Rapidly
- [ ] Click ▶, ▶, ◀, ▶, ◀, ◀, ▶ (random order, fast)
- [ ] Verify: Smooth, no glitches
- [ ] Verify: Count matches clicks (test your sanity)

### Test 2.4: Replay at Boundaries
- [ ] Enter replay, click ▶ until at last candle
- [ ] Verify: Can't go further forward (button click does nothing)
- [ ] Verify: Can click ◀ to go back
- [ ] Reset, click ◀ repeatedly
- [ ] Verify: Stops at first candle (doesn't go negative)

---

## 📊 SECTION 3: MULTI-CHART CONSISTENCY

### Test 3.1: Replay Affects All Charts
- [ ] Make sure layout is **2 Charts** or more
- [ ] Enter replay
- [ ] Step forward
- [ ] Verify: **Both charts advance together**
- [ ] Verify: Same candle count on each
- [ ] Verify: No desync

### Test 3.2: Layout Switch During Replay
- [ ] Enter replay, advance a few candles
- [ ] Change layout: **2 → 3 → 6 → 2**
- [ ] Verify: Replay continues correctly
- [ ] Verify: Candle count stays consistent
- [ ] Verify: No crashes

---

## 🎯 SECTION 4: SYMBOL/TIMEFRAME CHANGES

### Test 4.1: Change Symbol During Replay
- [ ] Enter replay (on NQ by default)
- [ ] Advance 20 candles
- [ ] Click **ES** button
- [ ] Verify: Chart updates cleanly
- [ ] Verify: No blank chart
- [ ] Verify: Replay index still valid
- [ ] Click ▶ again → works
- [ ] Click **NQ** → back to NQ
- [ ] Verify: Replay still works

### Test 4.2: Change Timeframe During Replay
- [ ] Enter replay (on 15s by default)
- [ ] Advance 20 candles
- [ ] Click **1m** button
- [ ] Verify: Chart updates (fewer candles = shorter history)
- [ ] Verify: No blank chart
- [ ] Verify: Replay index safe
- [ ] Click ▶ → works
- [ ] Switch to **3m** → works
- [ ] Back to **15s** → works

### Test 4.3: Rapid Symbol/Timeframe Switching
- [ ] Enter replay, advance 30 candles
- [ ] Click: ES, 1m, NQ, 3m, ES, 15s, NQ, 1m (rapid)
- [ ] Verify: No crashes
- [ ] Verify: No blank charts
- [ ] Verify: Replay still works after

---

## 🎨 SECTION 5: DRAWING DURING REPLAY

### Test 5.1: Draw Trendline During Replay
- [ ] Enter replay, advance 20 candles
- [ ] Select **trendline** tool
- [ ] Draw a trendline on the chart
- [ ] Verify: Trendline appears
- [ ] Click ▶ again
- [ ] Verify: Trendline stays (doesn't reset)
- [ ] Draw another trendline
- [ ] Click ▶, ▶, ▶
- [ ] Verify: Both trendlines persist

### Test 5.2: Modify Drawing During Replay
- [ ] Draw a trendline
- [ ] Click on it to select (should show handles)
- [ ] Drag to move it
- [ ] Verify: Drag works smoothly
- [ ] Verify: No glitches
- [ ] Click ▶ to step forward
- [ ] Verify: Trendline stays in place

### Test 5.3: Delete Drawing During Replay
- [ ] Draw a trendline
- [ ] Click to select it
- [ ] Press Delete key
- [ ] Verify: Trendline deleted
- [ ] Click ▶ to step forward
- [ ] Verify: Stays deleted (doesn't reappear)

---

## 🔄 SECTION 6: UI/UX RESPONSIVENESS

### Test 6.1: Tool Selection During Replay
- [ ] Enter replay
- [ ] Click **/** tool (trendline) → highlight should show
- [ ] Click **[]** tool (rectangle) → highlight should show
- [ ] Click **T** tool (text) → highlight should show
- [ ] Verify: Tools switch instantly (no lag)

### Test 6.2: Sidebar Responsiveness
- [ ] Enter replay
- [ ] Click magnet toggle
- [ ] Verify: Responds instantly
- [ ] Click tool buttons
- [ ] Verify: Every button responds

### Test 6.3: Light/Dark Mode During Replay
- [ ] Enter replay, advance candles
- [ ] Click **☀️** (light mode)
- [ ] Verify: Chart updates, stays visible
- [ ] Verify: Trendlines still visible
- [ ] Click **🌙** (dark mode)
- [ ] Verify: Smooth transition
- [ ] Verify: Replay still works

### Test 6.4: Theme Preset During Replay
- [ ] Enter replay
- [ ] Change theme preset: Professional → Premium → Vibrant
- [ ] Verify: Chart updates smoothly
- [ ] Verify: Candlestick colors change
- [ ] Verify: Replay keeps working

---

## 🧱 SECTION 7: PERFORMANCE

### Test 7.1: 2 Charts + Replay
- [ ] Layout: **2 Charts**
- [ ] Enter replay, advance 50 candles
- [ ] Verify: Smooth, no stuttering
- [ ] Verify: CPU doesn't spike

### Test 7.2: 3 Charts + Replay
- [ ] Layout: **3 Charts**
- [ ] Enter replay, advance 50 candles rapidly
- [ ] Verify: Acceptable smoothness
- [ ] Verify: No lag

### Test 7.3: 6 Charts + Replay
- [ ] Layout: **6 Charts**
- [ ] Enter replay, advance 30 candles
- [ ] Verify: No crash
- [ ] Verify: Responsive (even if slightly slower)

---

## 🎥 SECTION 8: REAL USAGE (YOUTUBE SCENARIO)

**Pretend you're recording a YouTube video explaining a trade setup**

### Scenario:
1. Open app
2. Enter **Replay** mode
3. Explain: "Here's the liquidity grab setup"
4. Draw a **rectangle** around the liquidity zone
5. Click **▶** to advance candle
6. Explain: "Price sweeps, then reverses"
7. Draw a **trendline** showing the reversal
8. Click **▶, ▶, ▶** to show 3 more candles
9. Explain: "Entry here, stop there"
10. Exit replay, show live
11. Comment: "And now we're live trading the same setup"

### Checklist:
- [ ] Entire flow felt smooth
- [ ] No lag between explanations and clicks
- [ ] Drawings stayed where I wanted them
- [ ] Graphics looked professional
- [ ] Felt natural (not robotic/stuttery)

---

## 📝 SECTION 9: FRICTION LOG

After completing all tests, **write down**:

```
FRICTION POINT 1:
- What happened?
- When does it occur?
- How often (every time / sometimes)?

FRICTION POINT 2:
[same as above]

FRICTION POINT 3:
[same as above]
```

---

## ✅ FINAL SIGN-OFF

When all tests pass:

👉 **Say: "ready for next phase"**

Then:
- If no friction → we move to autoplay + pro features
- If friction found → we fix + re-test
- If critical bug → we patch + re-validate
