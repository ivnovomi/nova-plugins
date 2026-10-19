# NOVA Plugins

La tienda de plugins de **NOVA TV**: canales, filas para «Para ti», búsquedas, fondos de salvapantallas y apps para la tele, creados con [`@novatv/sdk`](https://www.npmjs.com/package/@novatv/sdk).

Se instalan desde **NOVA → Tienda**.

## En la tienda

| Plugin | Qué aporta | Versión |
|---|---|---|
| [Pluto TV](plugins/es.novatv.pluto-tv) | Cientos de canales gratis con anuncios, con su guía | [1.1.0](https://github.com/ivnovomi/nova-plugins/releases/tag/es.novatv.pluto-tv-1.1.0) |

## Qué hay aquí

```
plugins/<id>/          el código fuente de cada plugin publicado
store/catalog.json     el catálogo que lee NOVA: fichas, destacados y colecciones
```

Los paquetes (`.novapkg`) van en las [releases](https://github.com/ivnovomi/nova-plugins/releases), uno por versión y **firmados con la clave de la tienda**. NOVA comprueba la firma, la huella SHA-256 y que el plugin pide exactamente los permisos que el usuario aprueba, y si algo no cuadra no lo instala.

## Publicar un plugin

1. Créalo con `npm create nova-plugin` y pruébalo en tu NOVA con `npx nova dev`.
2. Envía **el código fuente** a `plugins/<id>/` con un pull request.
3. El equipo de NOVA lo revisa: el código (el paquete va minificado pero legible), los permisos y que haga lo que dice.
4. Si se aprueba, se empaqueta, se firma y aparece en la tienda de todas las NOVA TV.

Solo se publican plugins revisados. Las normas de contenido (resumen): nada de piratería ni de saltarse DRM, sin apuestas, sin contenido adulto, sin anuncios insertados y sin seguimiento.

## Licencia

El SDK y las herramientas se publican con licencia MIT. Cada plugin indica la suya. NOVA TV es un proyecto independiente de ivnovomi.
