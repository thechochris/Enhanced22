# Enhanced22

A Chrome/Edge extension that makes NFL+ All-22 replays easier to watch:

- **Game overlay** on the video: quarter and clock, down and distance, field position, who has the ball, score, and play type.
- **Play list** beside the video. Click any play to jump to it, or press **N** / **P** for next / previous.
- **Sideline view only.** The All-22 replay shows each play twice (sideline, then end zone). Turn on **Auto-skip end zone view** (or press V) to skip it automatically. It is off by default.
- **Broadcast audio** (in progress): plays the TV broadcast's audio, from a second tab, in sync with the All-22 film.

The extension only reads the player's position and seeks it, like you would with the mouse. It never downloads, records or decodes the video, so NFL+ playback and DRM are untouched. Game data comes from the free public [nflverse](https://github.com/nflverse/nflverse-data) play-by-play, which updates the morning after games.

## Install (Windows, Chrome or Edge)

1. Download or clone this repository.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the `extension` folder.
4. After updating the extension, refresh any open NFL+ tabs.

## Watching a game

1. Open the game's All-22 replay on NFL+. The Enhanced22 panel appears on the video.
2. The game is picked automatically from the NFL+ page address. If it can't tell, pick it in the panel. The first time, it downloads that season's play-by-play (about 10 MB). Use **Change game** to switch later.
3. **Auto-sync (recommended).** Start the replay, then click **Auto-sync game** in the panel. It fast-forwards through the replay once at 8x with the sound off (about 12 minutes for a full game), finds the camera cuts, tells the sideline angle from the end zone angle, and matches each sideline clip to its play using the play's real length from the play-by-play. Only tiny thumbnails are analyzed, in memory, on your computer. If a play landed in the wrong spot, go to where it really starts and shift-click it in the list. The extension then re-matches every other play around your fix, without rescanning. **Export sync data** saves the scan to a file you can send for tuning. You can stop the scan at any point: the plays found so far are kept, and the button changes to **Resume auto-sync** to pick up where it stopped. Plays you placed by hand are never overwritten.
4. **Or sync by hand.** The All-22 replay has no markers, so the first time through, press **S** at the snap of each play's sideline view. The box at the bottom tells you which play is next. Press **X** if that play isn't in the replay, **Z** to undo. Watching at 2x is fine. Your sync is saved, so you only do this once per game.
5. After that, the overlay follows along and every play in the list is clickable.

The end of the sideline view is estimated as the midpoint between two snaps, since both angles show the same play. If one is off, press **E** at the moment the sideline view ends. Shift-click a play in the list to move its start to the current time.

Drag the panel by its title bar anywhere in the browser window, and resize it from the grip in its bottom-right corner and the score banner anywhere on the video. Double-click either one to put it back.

## Broadcast audio

Each play in the data has the real wall-clock time of its snap, so after one matching point the broadcast can follow the All-22 film play by play.

1. Open the same game's full broadcast replay in a second tab (ideally its own window), and click **Use this tab for broadcast audio** in the Enhanced22 panel there.
2. In the All-22 tab, go to any synced play. Switch to the broadcast tab, find the same snap, and press **B**.
3. Switch back to the All-22 tab and play. The broadcast tab follows, so you hear its audio over the All-22 film. Mute the All-22 video if it has its own sound.

Press **[** or **]** (in either tab) to nudge the broadcast audio a quarter second earlier or later. The broadcast keeps playing through each play's end zone replay and jumps to the next play when it starts. At the start of a play the All-22 video waits (up to 8 seconds) until the broadcast audio is ready. The green bar on the broadcast tab shows what the audio is doing.

If the broadcast replay has cuts (commercial breaks removed), add another **B** anchor after any break where the audio drifts. **U** removes the last anchor. While you're actively using the broadcast tab, it stops following so you can scrub freely.

## Keys

| Key | All-22 tab | | Key | Broadcast tab |
|---|---|---|---|---|
| S | sync next play at its snap | | B | anchor audio at this snap |
| X | next play isn't in the replay | | U | remove last anchor |
| Z | undo last sync | | | |
| E | mark end of sideline view | | | |
| N / P | next / previous play | | | |
| V | toggle auto-skip of the end zone view (off by default) | | | |
| O / L | toggle overlay / play list | | | |

## Known limits

- Not yet tested on the live NFL+ site. If NFL+ plays video inside a frame on a non-nfl.com domain, the page match in `manifest.json` needs that domain added.
- The overlay can't draw over a video that is itself fullscreen, only over a fullscreen player container (which is how most players work).
