# Asset library of the 3D studio (module s3d05): no system, no program, only files.
# Mounted read-only on /assets by the Kubernetes "image" volume (MCP server and workers).
#   node importer.mjs   (downloads, prepares, then: docker build -t studio3d-assets:<version> .)
FROM scratch
COPY library/ /
LABEL org.opencontainers.image.title="studio3d-assets" \
      org.opencontainers.image.description="Asset library of the 3D studio: Blender objects, HDRIs, thumbnails, catalog" \
      org.opencontainers.image.licenses="CC0-1.0"
