FROM python:3.13-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY server ./server
COPY static ./static

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

RUN mkdir -p /data

EXPOSE 8080

# uvicorn directly (run.py is for local dev — picks ports, opens browser).
# --proxy-headers + --forwarded-allow-ips so request.url.scheme reflects the
# original https and the WebSocket upgrade survives fly's edge proxy.
CMD ["uvicorn", "server.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--proxy-headers", \
     "--forwarded-allow-ips", "*"]
