# Misma Palabra

Juego de asociación online: cada jugador escribe una palabra en secreto, se revelan a la vez y, si no coinciden, hay que buscar otra que conecte con las anteriores. Gana el grupo cuando todos escriben la misma.

- Salas privadas de 2 a 6 jugadores, con código o enlace de invitación.
- 30 s, 60 s o tiempo personalizado por ronda.
- Sin servidor propio: el navegador que crea la sala hace de anfitrión y los demás se conectan por WebRTC ([PeerJS](https://peerjs.com/)).

## Probar en local

```bash
node servidor.js
```

y abre http://localhost:4321.
