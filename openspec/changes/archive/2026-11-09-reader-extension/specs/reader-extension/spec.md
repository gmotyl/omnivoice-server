# reader-extension

## ADDED Requirements

### Requirement: Read the page's article
Starting a reading session without a selection reads the article container that Readability identifies, from its first sentence.

#### Scenario: Article page
- **WHEN** the user clicks the toolbar icon on a page with an article and nothing selected
- **THEN** the player bar appears and the first sentence of the article container is spoken and highlighted

#### Scenario: No article found
- **WHEN** Readability finds no article container
- **THEN** the session reads the page body, skipping `nav`, `header`, `footer`, `aside` and `aria-hidden` elements

### Requirement: Read the selection
Starting a session while text is selected reads only the selected text.

#### Scenario: Context menu on a selection
- **WHEN** the user selects two sentences and chooses "Read selection" from the context menu
- **THEN** exactly those two sentences are spoken and the session ends after the second

#### Scenario: Selection cuts a sentence
- **WHEN** the selection starts in the middle of a sentence
- **THEN** reading starts at the first selected character, not at the start of that sentence

### Requirement: Start from a clicked paragraph
Alt+click on a paragraph of the reading source starts reading at that paragraph's first sentence.

#### Scenario: Alt+click during a session
- **WHEN** a session is playing sentence 3 and the user Alt+clicks paragraph 7
- **THEN** pending audio is discarded and the first sentence of paragraph 7 is spoken next

#### Scenario: Alt+click with no session
- **WHEN** no session is running and the user Alt+clicks a paragraph inside the article container after starting the extension on the tab
- **THEN** a session starts at that paragraph

### Requirement: Sentence and paragraph navigation
The player bar's previous/next controls move by one sentence; with Shift they move to the start of the previous/next paragraph.

#### Scenario: Next sentence
- **WHEN** sentence 4 is playing and the user presses Next
- **THEN** sentence 5 starts playing and is highlighted

#### Scenario: Previous paragraph
- **WHEN** a sentence in the middle of paragraph 3 is playing and the user presses Shift+Previous
- **THEN** the first sentence of paragraph 3 starts playing

#### Scenario: Shift+Previous at a paragraph start
- **WHEN** the first sentence of paragraph 3 is playing and the user presses Shift+Previous
- **THEN** the first sentence of paragraph 2 starts playing

#### Scenario: Bounds
- **WHEN** the first sentence is playing and the user presses Previous
- **THEN** the first sentence restarts

### Requirement: Highlight the current sentence
The sentence being spoken is highlighted on the original page without changing the page's DOM, and scrolled into view when off-screen.

#### Scenario: Next sentence below the fold
- **WHEN** the next sentence starts and lies below the visible viewport
- **THEN** the page scrolls so the sentence is visible and only that sentence carries the highlight

#### Scenario: Page DOM untouched
- **WHEN** a session highlights sentences
- **THEN** no element is added to, removed from or modified in the article container

### Requirement: Speak through an OpenAI-compatible engine
Each sentence is synthesised with `POST {baseUrl}/audio/speech` carrying `model`, `input` and `voice`, with a Bearer `Authorization` header only when an API key is set.

#### Scenario: Prefetch
- **WHEN** sentence i starts playing
- **THEN** requests for sentences i+1 to i+3 are in flight or done

#### Scenario: Seek aborts pending requests
- **WHEN** the user jumps from sentence 2 to sentence 20
- **THEN** in-flight requests for sentences 3 to 5 are aborted and requests for 20 to 23 are started

#### Scenario: Long sentence
- **WHEN** a sentence is longer than 400 characters
- **THEN** it is sent as pieces of at most 400 characters cut at spaces, played in order under one highlight

#### Scenario: Engine error
- **WHEN** the engine answers with an HTTP error or is unreachable
- **THEN** playback stops and the player bar shows the error, an "Open options" link and a Retry button

### Requirement: Player bar controls
The player bar offers play/pause, previous, next, voice, speed and close.

#### Scenario: Speed change
- **WHEN** the user sets speed to 1.3 during playback
- **THEN** the current and following sentences play at 1.3× without a new request

#### Scenario: Voice change
- **WHEN** the user picks another voice during playback
- **THEN** prefetched audio is discarded and the current sentence restarts in the new voice

#### Scenario: Close
- **WHEN** the user closes the player bar
- **THEN** playback stops, pending requests are aborted and the highlight is cleared

### Requirement: Session lifecycle
A session belongs to one tab and ends when that tab navigates, reloads or closes.

#### Scenario: Tab reload
- **WHEN** the tab of a playing session reloads
- **THEN** audio stops within one second

#### Scenario: Second tab
- **WHEN** a session plays in tab A and the user starts reading in tab B
- **THEN** the session in tab A stops and tab A's bar and highlight are removed

### Requirement: Options
The options page stores base URL, API key, voice and speed, lists voices from the engine and tests the connection.

#### Scenario: Voice list
- **WHEN** the options page opens with base URL `http://localhost:8892/v1`
- **THEN** the voice select lists the ids from `GET /v1/audio/voices`

#### Scenario: Voice list fallback
- **WHEN** `GET {baseUrl}/audio/voices` fails but `GET {baseUrl}/models` succeeds
- **THEN** the connection is reported OK and the voice field becomes free text

#### Scenario: Non-local server
- **WHEN** the user saves base URL `https://spock.example.ts.net:8444/v1`
- **THEN** the extension requests host permission for that origin and saves only if it is granted

### Requirement: Start triggers and narrow permissions
Reading starts from the toolbar icon, the `Alt+Shift+R` shortcut, or the context menu ("Read selection", "Read from here"); the extension holds no all-sites host permission.

#### Scenario: Shortcut toggles
- **WHEN** a session is playing and the user presses Alt+Shift+R
- **THEN** playback pauses, and pressing it again resumes

#### Scenario: Manifest permissions
- **WHEN** the manifest is inspected
- **THEN** `host_permissions` contains only localhost and 127.0.0.1 origins and no `<all_urls>`, and no script is loaded from a remote URL
