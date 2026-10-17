City seal assets
================

These local images identify the active city beside the chat input. The badge links
to that city's official website. It updates when a jurisdiction event arrives;
counties or failed image loads use initials instead.

`manifest.json` records each image's source, original image URL and available
attribution/license metadata. Wikimedia images are taken specifically from the
city infobox's `image_seal` field, not arbitrary photos or favicons. Nine additional
sources are listed in `config/city_seal_sources.json`. Source reproductions may
lag changes to a city's official design; update the manifest when designs change.

Run `node scripts/collect_city_seals.mjs` from the repository root to collect
missing assets. Existing assets are reused. Collection needs network access;
normal app use serves these files locally and makes no image requests to third parties.

City seals remain the identifying insignia of their respective municipalities;
displaying them does not imply that GovAI is an official city service.
