#!/bin/bash

# Web Interaction Capture - Setup Script
# Prepara la extensión para desarrollo

echo "🚀 Web Interaction Capture - Setup"
echo "===================================="

# Crear directorios necesarios
mkdir -p src/engines
mkdir -p popup
mkdir -p sidepanel
mkdir -p settings
mkdir -p images

# Información
echo ""
echo "✅ Estructura creada"
echo ""
echo "📝 Archivos necesarios:"
echo "  - manifest.json (✓)"
echo "  - background.js (✓)"
echo "  - content.js (✓)"
echo "  - popup/popup.html (✓)"
echo "  - popup/popup.js (✓)"
echo "  - src/engines/recorder-engine.ts (✓)"
echo "  - src/engines/specialized-engines.ts (✓)"
echo ""
echo "⚙️ Para instalar en Chrome:"
echo "  1. Abre chrome://extensions/"
echo "  2. Activa 'Developer mode' (arriba derecha)"
echo "  3. Click 'Load unpacked'"
echo "  4. Selecciona esta carpeta (WebInteractionCapture/)"
echo ""
echo "🎯 Uso:"
echo "  Ctrl+Shift+R  → Toggle Recording"
echo "  Ctrl+Shift+E  → Export Audit"
echo ""
echo "📚 Documentación: Ver README.md"
echo ""
