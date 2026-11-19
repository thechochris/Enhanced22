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
3. **Auto-sync (recommended).** Start the replay, then click **Auto-sync game** in the panel. It fast-forwards through the replay once at 8x with the sound off (about 12 minutes for a full game), finds the camera cuts, tells the sideline angle from the end zone angle (by how each shot opens, so a camera panning after a long pass doesn't end the sideline view early), and matches each sideline clip to its play using the play's real length from the play-by-play. It also finds the snap inside each clip, where the still picture of the teams lined up starts moving; the time before the snap varies from 3 to 17 seconds, so the audio is lined up to that moment rather than to a fixed lead. Only tiny thumbnails are analyzed, in memory, on your computer. Keep the replay tab in front while it scans: the scan pauses while the tab is hidden, and if Chrome skips frames it goes back and re-reads that stretch more slowly. If a scan still missed more than 10% of the video, the panel tells you so you can run it again. If a play landed in the wrong spot, go to where it really starts and shift-click it in the list. The extension then re-matches every other play around your fix, without rescanning. **Export sync data** saves the scan to a file you can send for tuning. You can stop the scan at any point: the plays found so far are kept, and the button changes to **Resume auto-sync** to pick up where it stopped. Plays you placed by hand are never overwritten.
4. **Or sync by hand.** The All-22 replay has no markers, so the first time through, press **S** at the snap of each play's sideline view. The box at the bottom tells you which play is next. Press **X** if that play isn't in the replay, **Z** to undo. Watching at 2x is fine. Your sync is saved, so you only do this once per game.
5. After that, the overlay follows along and every play in the list is clickable.

The end of the sideline view is estimated as the midpoint between two snaps, since both angles show the same play. If one is off, press **E** at the moment the sideline view ends. Shift-click a play in the list to move its start to the current time.

Drag the panel by its title bar anywhere in the browser window, and resize it from the grip in its bottom-right corner and the score banner anywhere on the video. Double-click either one to put it back.

## Broadcast audio

Each play in the data has the real wall-clock time of its snap, so after one matching point the broadcast can follow the All-22 film play by play.

1. Open the same game's full broadcast replay in a second tab (ideally its own window), and click **Use this tab for broadcast audio** in the Enhanced22 panel there.
2. In the All-22 tab, go to any synced play. Switch to the broadcast tab, find the same snap, and press **B**.
3. Switch back to the All-22 tab and play. The broadcast tab follows, so you hear its audio over the All-22 film. Mute the All-22 video if it has its own sound.

The full-game broadcast replay leaves out the commercial breaks, so the extension spots breaks in the play-by-play (gaps of more than about 2 minutes 20 seconds between snaps) and takes them out of the timing automatically. Across a break the timing is an estimate (the replay keeps about 16 seconds between the last snap before a break and the first after it), and the panel tells you when it is. Press **B** on the broadcast tab at the snap of the first play after a break to make it exact from there on. If the audio is ahead of the video, press **[** (in either tab) to move it a tenth of a second later; **]** moves it earlier. The fix applies from the current play onward and leaves earlier plays alone, because the full-game replay drops commercial breaks and the right timing can change after each one. The broadcast tab also allows for the tiny delay between tabs, learns how far ahead to aim when it has to jump, and closes small gaps by speeding up or slowing down slightly. The broadcast keeps playing through each play's end zone replay, but stops just before the next snap so it never runs ahead into the next play, and continues when that play starts. At the start of a play the All-22 video waits (up to 8 seconds) until the broadcast audio is ready. The green bar on the broadcast tab shows what the audio is doing.

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
- Full screen: the panel, scorebug and toasts stay on screen. When a player puts the bare video in full screen (which would leave no room for anything on top), a small script in the page sends that request to the video's container instead, so it looks the same with the overlay on top.

## Play details

Each play in the list and in the on-video scorebug shows who had the ball (passer → intended receiver, ball carrier, or kick returner), sacks with who made them, the yards gained or lost, interceptions and lost fumbles, any penalty with its type, the player, the yards and whether it was declined or offset, a red **TD** tag on touchdowns, the team with the ball in a box in its team color, and for field goals and extra points the kicker, the distance and a green **FG ✓** / grey **FG ✗** tag (XP for extra points). The scorebug puts both teams' scores up front in team colors, with a dot on the team that has the ball, then the quarter, clock, down and distance, and ball spot. These come from the same nflverse play-by-play. Seasons downloaded by an older version are downloaded again automatically the first time.

The search box above the play list filters it as you type. Every word must match: a player (Purdy, Lamb), a team (SF, 49ers, Cowboys, meaning plays where that team had the ball), or a kind of play (touchdown, field goal, sack, interception, penalty, punt, missed). For example, *49ers touchdown* or *Aubrey field goal*. Esc clears it.

## Finding the plays in the broadcast automatically

On the broadcast tab, click **Find plays in this broadcast** (in the green bar). It fast-forwards through the broadcast once with the sound off (about 15 to 20 minutes for a full game; keep that tab in front). It looks for the moment the wide game camera starts moving after the teams line up, which is the snap, and lines those up with the play-by-play's snap times. Between two commercial breaks, the broadcast's time from snap to snap matches the real time exactly, so one fit per stretch places every play in it. Shorter stops (timeouts, reviews) also lose some time in the replay, so the scan treats those as their own stretches and also checks for a cut inside a stretch when its later plays stop lining up. Stretches it can't place fall back to your **B** anchors or to the break estimate. You can stop and resume it. **Reset audio sync** (click twice) clears the anchors, nudges and broadcast scan for the game so you can start over. **Export broadcast scan** saves the scan to a file you can send for tuning.

