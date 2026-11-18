# Enhanced22

A Chrome/Edge extension that makes NFL+ All-22 replays easier to watch:

- **Game overlay** on the video: quarter and clock, down and distance, field position, who has the ball, score, and play type.
- **Play list** beside the video. Click any play to jump to it, or press **N** / **P** for next / previous.
- **Sideline view only.** The All-22 replay shows each play twice (sideline, then end zone). The end zone view is skipped automatically.
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
3. **Sync once per game.** The All-22 replay has no markers, so the first time through, press **S** at the snap of each play's sideline view. The box at the bottom tells you which play is next. Press **X** if that play isn't in the replay, **Z** to undo. Watching at 2x is fine. Your sync is saved, so you only do this once per game.
4. After that, the overlay follows along, the end zone view is skipped, and every play in the list is clickable.

The end of the sideline view is estimated as the midpoint between two snaps, since both angles show the same play. If one is off, press **E** at the moment the sideline view ends. Shift-click a play in the list to move its start to the current time.

Drag the panel by its title bar and the score banner anywhere on the video. Double-click either one to put it back.

## Broadcast audio

Each play in the data has the real wall-clock time of its snap, so after one matching point the broadcast can follow the All-22 film play by play.

1. Open the same game's full broadcast replay in a second tab. Click the Enhanced22 button there and choose **Use this tab**.
2. In the All-22 tab, go to any synced play. Switch to the broadcast tab, find the same snap, and press **B**.
3. Switch back to the All-22 tab and play. The broadcast tab follows, so you hear its audio over the All-22 film. Mute the All-22 video if it has its own sound.

If the broadcast replay has cuts (commercial breaks removed), add another **B** anchor after any break where the audio drifts. **U** removes the last anchor. While you're actively using the broadcast tab, it stops following so you can scrub freely.

## Keys

| Key | All-22 tab | | Key | Broadcast tab |
|---|---|---|---|---|
| S | sync next play at its snap | | B | anchor audio at this snap |
| X | next play isn't in the replay | | U | remove last anchor |
| Z | undo last sync | | | |
| E | mark end of sideline view | | | |
| N / P | next / previous play | | | |
| V | toggle sideline view only | | | |
| O / L | toggle overlay / play list | | | |

## Known limits

- Not yet tested on the live NFL+ site. If NFL+ plays video inside a frame on a non-nfl.com domain, the page match in `manifest.json` needs that domain added.
- The overlay can't draw over a video that is itself fullscreen, only over a fullscreen player container (which is how most players work).
