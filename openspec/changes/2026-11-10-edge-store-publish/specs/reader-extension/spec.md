## ADDED Requirements

### Requirement: Lektor TTS identity
The extension is named "Lektor TTS", is versioned 1.0.0 for its first store release, and uses one icon rendered from a single SVG source.

#### Scenario: Name in the browser
- **WHEN** the extension is installed and the user hovers the toolbar icon or opens the extensions page
- **THEN** it shows the name "Lektor TTS" and the "L" monogram icon, and no text says "OmniVoice Reader"

#### Scenario: Icons from one source
- **WHEN** `node scripts/render-icons.mjs` runs
- **THEN** `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` and `store/logo-300.png` are written from `icons/icon.svg` at those exact pixel sizes

### Requirement: Engine presets
The extension offers three engine presets: OpenAI, own omnivoice-server, and other OpenAI-compatible server.

#### Scenario: OpenAI preset fills the engine
- **WHEN** the user selects the OpenAI preset
- **THEN** the base URL becomes `https://api.openai.com/v1`, the model `gpt-4o-mini-tts`, no URL field is shown, and the voice select lists the 11 voices of `gpt-4o-mini-tts`

#### Scenario: Voices follow the OpenAI model
- **WHEN** the OpenAI preset is selected and the user changes the model under "More settings" to `tts-1`
- **THEN** the voice select lists the 9 voices of `tts-1`, keeping the current voice if it is among them, else the first one

#### Scenario: omnivoice-server preset
- **WHEN** the user selects the omnivoice-server preset
- **THEN** the address is `http://localhost:8892/v1` and a "Quick start" link opens `https://github.com/gmotyl/omnivoice-server#quick-start-read-web-pages-aloud` in a new tab

#### Scenario: Other server preset
- **WHEN** the user selects the Other server preset
- **THEN** a base URL field, an optional API key field and a voice field are shown, the voice being a select when the engine lists voices and free text otherwise

### Requirement: Setup screen on install
A fresh install opens the options page as the setup screen; an update opens nothing.

#### Scenario: Fresh install
- **WHEN** the extension is installed (`onInstalled` reason `install`)
- **THEN** the options page opens in a new tab with no preset selected yet

#### Scenario: Update
- **WHEN** the extension is updated (`onInstalled` reason `update`)
- **THEN** no tab is opened

### Requirement: Setup prompt while unconfigured
Before any engine preset was saved, starting a reading session shows a setup prompt instead of calling an engine.

#### Scenario: Icon click while unconfigured
- **WHEN** no preset is saved and the user clicks the toolbar icon, presses Alt+Shift+R or uses a context menu item
- **THEN** the player bar shows "Lektor needs a speech engine before it can read." with a "Set up a speech engine" button and a close button, and no `/audio/speech` request is made

#### Scenario: Open setup from the prompt
- **WHEN** the user clicks "Set up a speech engine"
- **THEN** the options page opens

### Requirement: Settings migration
Settings saved before presets existed keep working without the setup prompt.

#### Scenario: Existing omnivoice-server setup
- **WHEN** stored settings have no `preset` and `baseUrl` `http://localhost:8892/v1` with a saved voice
- **THEN** `preset` is set to `omnivoice` and reading starts without a setup prompt

#### Scenario: Existing other server
- **WHEN** stored settings have no `preset` and `baseUrl` `https://spock-wsl.example.ts.net:8444/v1`
- **THEN** `preset` is set to `other`

#### Scenario: Untouched defaults
- **WHEN** stored settings have no `preset` and every engine key equals the old defaults
- **THEN** the extension is unconfigured

## MODIFIED Requirements

### Requirement: Options
Was: the options page stores base URL, API key, model, voice, speed and autoscroll, lists voices from the engine and tests the connection with separate Save and Test connection buttons. Is: the options page is the setup screen — preset cards, the fields of the selected preset, one "Save and test" button, speed, autoscroll and model folded under "More settings", and a "Buy me a coffee" footer link.

#### Scenario: Save and test succeeds
- **WHEN** the user selects OpenAI, enters a valid key and clicks "Save and test"
- **THEN** the extension requests host permission for `https://api.openai.com`, saves the settings, calls `GET https://api.openai.com/v1/models` with the key, and shows "✓ Connected to OpenAI · 11 voices" with a hint how to start reading

#### Scenario: Wrong key
- **WHEN** the engine answers the test with HTTP 401
- **THEN** the engine's error message is shown under the button and the settings stay saved

#### Scenario: Permission denied
- **WHEN** the user declines the host permission request for a non-localhost origin
- **THEN** nothing is saved and the page shows "Lektor needs permission to reach <origin>"

#### Scenario: Voice list
- **WHEN** the omnivoice-server or Other preset is tested against an engine that answers `GET /audio/voices`
- **THEN** the voice select lists those ids

#### Scenario: Voice list fallback
- **WHEN** `GET {baseUrl}/audio/voices` fails but `GET {baseUrl}/models` succeeds for the Other preset
- **THEN** the connection is reported OK and the voice field becomes free text

#### Scenario: More settings collapsed
- **WHEN** the options page opens
- **THEN** speed, autoscroll and model are inside a collapsed "More settings" section
