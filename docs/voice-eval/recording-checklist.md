# Recording the 20 voice clips (do it today)

Used for `voice-eval --audio` (06-voice.md §9), which tests speech-to-text plus the brain end to end.

**Format:** WAV, 16 kHz, mono, 16-bit. Name the files `NN-quiet.wav` and `NN-noise.wav`, with NN as in `cases.json`. QuickTime records m4a; convert it with:
```
ffmpeg -i in.m4a -ar 16000 -ac 1 out.wav
```

**How to record:**
- Say each line from `cases.json` the way you'd say it in the heat of a battle: not slowly, not over-pronounced.
- **Quiet set:** indoors, the laptop's mic at a normal distance.
- **Noise set:** a fan, street noise or a café. This is a realistic demo-hall condition.
- Leave about 0.3 s of silence before and after each line, which matches the hold-to-talk timing.
- If someone else can record a set, add it with their initials (`NN-quiet-AB.wav`). Different accents catch name-matching problems early.

**Trying the speech models.** You already have `ggml-large-v3-turbo.bin` (in `Server/data/game-analysis/models/`). Also try `small.en` for speed:
```
whisper-cli -m ggml-large-v3-turbo.bin -f 04-quiet.wav --prompt "BORS WIL ODA REN MILL FORD NEST RIDGE OAKWOOD RIVER riders spears shields archers"
```
Compare word accuracy on the names, and the time per clip.
