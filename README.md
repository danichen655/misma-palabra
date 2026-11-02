# Misma Palabra · 想到一块儿

Juego de asociación online: cada jugador escribe una palabra en secreto, se revelan a la vez y, si no coinciden, hay que buscar otra que conecte con las anteriores. Gana el grupo cuando todos escriben la misma (o votan que son sinónimos).

- Salas privadas de 2 a 6 jugadores, con código o enlace de invitación.
- 30 s, 60 s o tiempo personalizado por ronda.
- En español y chino; la vista previa al compartir sale en el idioma de quien comparte (`/` y `/zh/`).

Web: https://danichen655.github.io/misma-palabra/

## Cómo está hecho

- **Web** (GitHub Pages): `index.html`, `estilo.css`, `juego.js`, `textos.js`.
- **Servidor de salas** (Cloudflare Workers + Durable Objects, plan gratuito): `backend/sala.js`. Cada sala guarda su estado, avanza las rondas con alarmas y se reconecta con los jugadores que pierden la conexión. Se publica en https://misma-palabra.misma-palabra.workers.dev
- **Reglas compartidas** por la web y el servidor: `reglas.js`.

## Probar en local

```bash
npm install
npm run servidor   # salas en http://localhost:8787
npm run web        # web en http://localhost:4321
```

En `localhost` la web usa el servidor de salas local automáticamente.

## Publicar

```bash
npm run desplegar  # servidor de salas a Cloudflare
git push           # la web se actualiza sola en GitHub Pages
```
