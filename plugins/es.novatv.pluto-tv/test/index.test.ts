// Pruebas sin abrir NOVA (ni Pluto): npm run nova -- test plugins/pluto-tv
//
// Las respuestas de mentira tienen la misma forma que las de Pluto de verdad:
// una sesión de boot.pluto.tv, los canales, las categorías y la guía.

import { testPlugin, test, assert } from "@novatv/sdk/testing";
import manifest from "../nova-plugin.json";
import plugin from "../src/index";

const API = "https://service-channels.clusters.pluto.tv/v2/guide";
let sesiones = 0;

const nova = testPlugin(manifest, plugin, {
  offline: true, // nada sale a internet: las respuestas son estas
  print: false,
  mock: (req) => {
    if (req.url.startsWith("https://boot.pluto.tv/v4/start")) {
      sesiones++;
      return {
        sessionToken: `token-${sesiones}`,
        stitcherParams: "appName=web",
        refreshInSec: 28800,
        servers: { stitcher: "https://stitcher.pluto.tv" },
        session: { activeRegion: "ES" },
      };
    }
    if (req.url.startsWith(`${API}/channels`)) {
      return {
        data: [
          { id: "bob1", name: "Bob Esponja ", number: 210, images: [{ type: "colorLogoPNG", url: "https://images.pluto.tv/bob.png" }] },
          { id: "terror1", name: "Pluto TV Terror", number: 640 },
          { id: "dbz1", name: "Dragon Ball", number: 300 },
          { id: "oficina1", name: "Solo para la oficina", number: 1, plutoOfficeOnly: true },
        ],
      };
    }
    if (req.url === `${API}/categories`) {
      return {
        data: [
          { name: "Infantil", channelIDs: ["bob1"] },
          { name: "Halloween", channelIDs: ["terror1"] },
          { name: "Películas de terror", channelIDs: ["terror1"] },
          { name: "Anime", channelIDs: ["dbz1"] },
        ],
      };
    }
    if (req.url.startsWith(`${API}/timelines`)) {
      return {
        data: [
          {
            channelId: "bob1",
            timelines: [{ start: "2026-10-18T16:00:00.000Z", stop: "2026-10-18T16:30:00.000Z", title: " Bob Esponja ", episode: { description: "Fondo de Bikini.", genre: "Animación" } }],
          },
        ],
      };
    }
  },
});

test("da sus canales, sin los internos de Pluto", async () => {
  const canales = await nova.channels();
  assert.deepEqual(canales.map((c) => c.name), ["Bob Esponja", "Pluto TV Terror", "Dragon Ball"]);
  assert.deepEqual(nova.problems, []);
});

test("traduce las categorías a temas de NOVA (y no se fía de las de temporada)", async () => {
  const [bob, terror] = await nova.channels();
  assert.deepEqual(bob.categories, ["Infantil"]);
  assert.equal(bob.number, 210);
  assert.equal(bob.logo, "https://images.pluto.tv/bob.png");
  assert.equal(terror.group, "Películas de terror", "Halloween no es su sitio");
  assert.deepEqual(terror.categories, ["Cine"]);
  assert.equal(terror.number, undefined, "640 no cabe en el bloque: NOVA le da uno");
});

test("el anime es infantil solo si la opción lo dice", async () => {
  assert.deepEqual((await nova.channels())[2].categories, ["Infantil"]);
  nova.setSetting("animeInfantil", false);
  assert.deepEqual((await nova.channels())[2].categories, ["Entretenimiento"]);
  nova.setSetting("animeInfantil", true);
});

test("la emisión va firmada y por el proxy; si Pluto la rechaza, sesión nueva", async () => {
  const antes = sesiones;
  const s = await nova.stream("bob1");
  assert.ok(s.type === "hls" && s.proxy);
  assert.match(s.type === "hls" ? s.url : "", /\/channel\/bob1\/master\.m3u8\?appName=web&jwt=token-\d+/);
  assert.equal(sesiones, antes, "reutiliza la sesión");
  await nova.stream("bob1", { retry: true });
  assert.equal(sesiones, antes + 1);
});

test("la guía, en segundos y sin espacios de más", async () => {
  const guia = await nova.guide(["bob1"]);
  const segundos = (iso: string) => Date.parse(iso) / 1000;
  assert.deepEqual(guia.bob1[0], {
    start: segundos("2026-10-18T16:00:00.000Z"),
    end: segundos("2026-10-18T16:30:00.000Z"),
    title: "Bob Esponja",
    description: "Fondo de Bikini.",
    genre: "Animación",
  });
  assert.deepEqual(nova.problems, []);
});

test("la sesión dura lo que dice Pluto", async () => {
  const antes = sesiones;
  nova.advance(8 * 3600);
  await nova.stream("bob1");
  assert.equal(sesiones, antes + 1);
});
