# Bibliothèque d'assets du studio 3D (module s3d05) : aucun système, aucun programme, seulement des fichiers.
# Montée en lecture seule sur /assets par le volume « image » de Kubernetes (serveur MCP et workers).
#   node importer.mjs   (télécharge, prépare, puis : docker build -t studio3d-assets:<version> .)
FROM scratch
COPY bibliotheque/ /
LABEL org.opencontainers.image.title="studio3d-assets" \
      org.opencontainers.image.description="Bibliothèque d'assets du studio 3D : objets Blender, HDRI, vignettes, catalogue" \
      org.opencontainers.image.licenses="CC0-1.0"
