FROM python:3.11-slim

ARG INSTALL_LEAN=true

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates bash \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/app

COPY requirements.txt ./requirements.txt
RUN pip install --upgrade pip && pip install -r requirements.txt

RUN if [ "$INSTALL_LEAN" = "true" ]; then \
      curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh -s -- -y; \
      /root/.elan/bin/elan default stable; \
      ln -sf /root/.elan/bin/lean /usr/local/bin/lean; \
      ln -sf /root/.elan/bin/lake /usr/local/bin/lake; \
      lean --version; \
      lake --version; \
    fi

COPY app ./app
COPY scripts ./scripts
RUN chmod +x ./scripts/*.sh

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
