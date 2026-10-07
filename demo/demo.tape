# record.sh encodes demo.webm from these lossless frames (see there for settings).
Output frames/

Set Shell bash
Set FontFamily "CozetteVector, BlexMono Nerd Font Mono"
# Rendered at 2x (same 1000x600 layout as 13px) so it stays sharp on HiDPI screens.
Set FontSize 26
Set Width 2000
Set Height 1200
Set Padding 0
Set Framerate 20
Set TypingSpeed 8ms
Set WaitTimeout 90s

Hide
Type "cd $DEMO_DIR/work && clear" Enter
Type "herdr --session omp-demo" Enter
Sleep 2s
Type "clear; omp --no-extensions -e $EXT --no-skills --no-rules --model anthropic/claude-haiku-5-5" Enter
Sleep 3s
# Prompt is entered while hidden, so the recording opens with it already in the composer.
Type "Call the task tool once with 5 agents named Demo1..Demo5, model anthropic/claude-haiku-5-5. Each runs `sleep $((RANDOM % 3 + 3))` with bash. When all 5 have reported back, reply exactly: don't forget to smash that like button!"
Show

Sleep 500ms
Enter
# Go RE2 has no lookbehind: match the reply as its own line (the prompt copy follows "reply exactly: ").
Wait+Screen /(?m)^[│\s]*don't forget to smash that like button!/
Sleep 2s
