# CRIPTO IA · Radar automático de criptomonedas

Proyecto independiente de los robots Deriv del usuario. Analiza **Binance Spot** y **DEX Screener** sin API keys privadas, ejecuta un radar de oportunidades e informa señales **SEÑAL / VIGILAR / DESCARTAR**. No compra ni maneja fondos.

## Estado del despliegue

- **GitHub Actions activo:** escaneo programado aproximadamente cada 5 minutos, aun si el teléfono está apagado. El horario exacto no está garantizado por GitHub. Últimas ejecuciones: [Actions](https://github.com/quispillocharly-gif/Cripto-ia-/actions/workflows/cripto-ia.yml).
- **Archivo actualizado:** [resultados.json](public/data/results.json). Cada ejecución exitosa guarda los datos actuales y el historial.
- **Interfaz móvil:** [public/index.html](public/index.html).
- **URL planeada del sitio:** https://quispillocharly-gif.github.io/Cripto-ia-/

## Activar el sitio (único ajuste de GitHub Pages)

Por los permisos actuales de GitHub, es necesario que el dueño active **Settings → Pages → Build and deployment → Source: GitHub Actions**. Después se publicará automáticamente en el enlace anterior en la siguiente ejecución (o usando **Actions → Cripto IA - escaneo y publicación → Run workflow**).

## Servidor dedicado opcional

El archivo `server.js` también puede ejecutarse en un hosting Node 22 con `npm start`. Ofrece `/api/results`, `/api/history` y `/api/health`; escanea cada 2 minutos si el servicio está despierto. Usa `DATA_PATH=/data/cripto-ia.json` con volumen para guardar historial. Railway requiere recursos de cuenta adicionales para crear un nuevo proyecto actualmente.

## Cómo se generan las señales

- **Spot:** velas de 5 minutos cerradas, EMA 20/50, RSI 14, ATR, ruptura de 20 velas y volumen relativo.
- **DEX:** datos de los tokens perfilados o impulsados en DEX Screener para Solana/Base/Ethereum. No cubre todos los tokens y la selección promocionada sesga los resultados.
- **Puntos 0–100:** puntuación *heurística*, NO probabilidad calibrada de ganar. Una puntuación elevada puede quedarse en **VIGILAR** si faltan confirmaciones.
- Se descartan condiciones extremas para no perseguir subidas excesivas, pero los filtros no detectan todos los contratos fraudulentos ni garantizan liquidez de salida.

**Limitaciones:** GitHub Actions puede retrasar/omitir ejecuciones, tiene cuotas y en repositorios públicos los workflows programados pueden deshabilitarse tras 60 días sin actividad humana. No es alojamiento de latencia continua ni una IA entrenada en resultados históricos. No realiza apuestas ni órdenes y no promete beneficio.
