# Car Ad Story Template Kit

A reusable set of pieces for scripting "customer-as-hero" car ads that feel like a famous movie moment. Built to be filled in by software: anything in `{CURLY_BRACES}` is a variable you swap per piece.

There is no single secret "movie template." What you're after is two public things combined:

1. **A story beat sheet** — the skeleton screenwriters use.
2. **A shot prompt template** — the format an AI video tool wants.

This kit gives you both, plus how to drop the customer in as the hero.

---

## PART 1 — The story skeletons (beat sheets)

These are the structures behind almost every "ordinary person → impossible thrill → transformed" ad. Pick one skeleton per piece. The first is the workhorse for a short ad; the other two are the famous full versions it's cut down from, in case you want more beats for a longer piece.

### A. The 6-beat short-ad arc (recommended default)

Every beat is one shot or a short cluster of shots. Sized for ~15–45 seconds.

| # | Beat | What happens | Job of the beat |
|---|------|--------------|-----------------|
| 1 | **Ordinary moment** | Customer in a mundane, relatable place — stuck in traffic, a dull errand, an ordinary street. | Make the customer recognize themselves. |
| 2 | **The spark** | Something shifts. The car appears, or a light, sound, or gesture signals that this is about to stop being ordinary. | Create the "wait, what?" |
| 3 | **Crossing over** | The customer gets in / touches the ignition / grips the wheel. Point of no return. | Hand the customer the power. |
| 4 | **The impossible** | The signature magic moment — the launch, the time-jump, the transformation, the scene bending around them. This is your "gasp." | Deliver the wow. This is what people remember. |
| 5 | **Mastery** | Hero shot: customer fully in control, calm and powerful, the world responding to them. | Let the customer feel like the hero. |
| 6 | **New world / payoff** | Arrival somewhere transformed. Reveal the car cleanly, land the tagline/logo. | Tie the feeling to the product. |

### B. The Hero's Journey (condensed — for longer pieces)

From Joseph Campbell / Christopher Vogler's *The Writer's Journey*. Full version is 12 stages; for an ad, use these mapped to the same 6 beats:

1. Ordinary World → beat 1
2. Call to Adventure + Refusal → beat 2
3. Crossing the Threshold → beat 3
4. Tests / Ordeal → beat 4 (the thrill *is* the ordeal)
5. Reward + Road Back → beat 5
6. Return Transformed → beat 6

### C. "Save the Cat" beats (condensed — Blake Snyder)

Snyder's beat sheet is 15 beats for a feature. The ones worth stealing for an ad:

- **Opening image** — the "before" (your beat 1).
- **Catalyst** — the thing that changes everything (your beat 2).
- **Break into Two** — commit to the new world (your beat 3).
- **Fun and Games** — "the promise of the premise," i.e. the cool stuff people came for (your beat 4). *This is the heart of an ad.*
- **Finale** — mastery and resolution (beats 5–6).
- **Final image** — the "after" that mirrors the opening (your beat 6).

**Where to go deeper:** *Save the Cat!* by Blake Snyder; *The Writer's Journey* by Christopher Vogler. Both are the actual "templates" filmmakers learn from — they're just books, not a hidden file.

---

## PART 2 — Putting the customer in as the hero

This is the "make it magic for him" part. Three ways to do it — pick per campaign:

- **`{HERO_MODE} = POV`** — Shoot from the customer's own eyes (first person). No face needed, works in any tool, and the viewer instantly *is* the driver. Safest and most universal.
- **`{HERO_MODE} = LIKENESS`** — The customer's real face is the driver. Most personal, but check that your chosen tool holds a consistent face across shots and that you have the customer's consent to use their image.
- **`{HERO_MODE} = PERSONALIZED`** — Generic driver, but the customer's name, city, or their own car model appears in the scene (a license plate, a sign, a line of narration). Lets one template personalize to thousands of customers without needing their face.

Small legal note so you don't get surprised: emulate the *feeling and structure* of a famous scene, not its protected specifics. A time-jump feels like Back to the Future without recreating the exact DeLorean time machine, its light-trails design, or any characters; a street race feels like Fast & Furious without brand logos or lifted footage. Structure and mood are free to borrow — specific iconic vehicles, characters, and logos are not.

---

## PART 3 — The shot prompt template (for the AI video tool)

One block per shot. Most tools (Sora, Veo, Runway, Kling) read the same ingredients; fill every field and you get consistent results. Keep each shot to a single continuous action — don't try to fit two beats in one clip.

```
SHOT {N} — {BEAT_NAME} — duration {SECONDS}s — aspect {ASPECT_RATIO}

SUBJECT:    {WHO_AND_WHAT_THEY_LOOK_LIKE}   // e.g. hero driver, {HERO_MODE}
ACTION:     {WHAT_HAPPENS_IN_ONE_SENTENCE}
CAMERA:     {ANGLE} + {MOVEMENT} + {LENS}   // e.g. low angle, slow push-in, 35mm
SETTING:    {WHERE}, {TIME_OF_DAY}
LIGHTING:   {LIGHT_QUALITY_AND_COLOR}
MOOD:       {EMOTION_ONE_OR_TWO_WORDS}
STYLE:      {FILM_LOOK}                      // e.g. cinematic, warm film grain, anamorphic
SOUND:      {AUDIO_OR_MUSIC_CUE}             // if the tool supports audio
CAR:        {CAR_MAKE_MODEL_COLOR_DETAILS}
```

**Field cheat-sheet (so your software can pick good values):**

- **CAMERA angle:** eye-level, low angle (makes hero powerful), high angle, over-the-shoulder, POV.
- **CAMERA movement:** static, slow push-in, pull-back reveal, tracking/follow, orbit, whip-pan, crane up.
- **LENS:** wide (24–35mm, epic/spacious), normal (50mm), telephoto (85mm+, intimate/compressed).
- **LIGHTING:** golden hour, blue hour, harsh midday, neon night, backlit rim light, moody low-key.
- **STYLE:** cinematic, film grain, anamorphic flares, high-contrast, desaturated, hyper-real.

---

## PART 4 — Full worked example (6 shots, wonder/BTTF-style, POV hero)

Variables used: `{CAR} = midnight-blue electric coupe`, `{HERO_MODE} = POV`, `{ASPECT_RATIO} = 9:16`.

```
SHOT 1 — Ordinary moment — 3s — aspect 9:16
SUBJECT:  driver's hands on the wheel, POV, sitting still
ACTION:   stuck at a red light on a grey ordinary street, rain starting
CAMERA:   eye-level POV, static, 35mm
SETTING:  drab city intersection, dusk
LIGHTING: flat overcast grey
MOOD:     bored, waiting
STYLE:    cinematic, slight film grain
SOUND:    dull city hum, a single raindrop
CAR:      midnight-blue electric coupe interior

SHOT 2 — The spark — 3s — aspect 9:16
SUBJECT:  driver's hands, POV
ACTION:   the dashboard glows to life, a soft pulse of light runs across it
CAMERA:   POV, slow push-in toward the glowing dash, 35mm
SETTING:  same intersection, dusk
LIGHTING: warm light rising from the dash against the grey
MOOD:     curiosity, "wait, what?"
STYLE:    cinematic
SOUND:    a rising electric tone

SHOT 3 — Crossing over — 2s — aspect 9:16
SUBJECT:  driver's hand, POV
ACTION:   hand presses the start button, decisive
CAMERA:   POV close-up, static, 50mm
SETTING:  car interior
LIGHTING: warm glow intensifying
MOOD:     commitment
SOUND:    deep confident whoosh

SHOT 4 — The impossible — 5s — aspect 9:16
SUBJECT:  driver POV
ACTION:   the grey street stretches and blurs into streaks of light as the world bends forward around the car
CAMERA:   POV, fast push-in, wide 24mm
SETTING:  street dissolving into a tunnel of light
LIGHTING: brilliant streaking light trails, warm-to-cool
MOOD:     awe, exhilaration
STYLE:    cinematic, anamorphic flares
SOUND:    swelling music, a sonic bloom

SHOT 5 — Mastery — 4s — aspect 9:16
SUBJECT:  driver POV, hands calm and steady on the wheel
ACTION:   the car glides effortlessly, the world now bright and open
CAMERA:   POV, gentle, 50mm
SETTING:  a stunning open coastal road, golden hour
LIGHTING: warm golden backlight
MOOD:     calm power, in control
SOUND:    music settling into a confident groove

SHOT 6 — New world / payoff — 4s — aspect 9:16
SUBJECT:  the {CAR} seen from outside for the first time
ACTION:   camera pulls back off the car parked at a breathtaking overlook; clean logo/tagline appears
CAMERA:   pull-back reveal + slow crane up, wide 24mm
SETTING:  cliff overlook at golden hour
LIGHTING: warm cinematic golden hour
MOOD:     arrival, aspiration
STYLE:    cinematic, hero product shot
SOUND:    music resolves, single clean note
CAR:      midnight-blue electric coupe, full exterior
```

---

## PART 5 — How your software plugs into this

For a campaign of several pieces, treat one row = one variable set, and loop:

**Per-piece variables:** `{SKELETON}` (A/B/C), `{FEELING}` (wonder / adrenaline / blend), `{HERO_MODE}`, `{CAR}`, `{ASPECT_RATIO}`, `{TAGLINE}`, `{SETTING_START}`, `{SETTING_END}`, `{MUSIC_STYLE}`.

**Per-shot variables:** everything in the Part 3 block.

Pipeline: pick skeleton → generate the 6 beats → expand each beat into a Part-3 shot block using the per-piece variables → hand each block to the AI video tool → stitch the clips. Keeping "one shot = one action" is the single biggest thing that keeps AI clips coherent.
