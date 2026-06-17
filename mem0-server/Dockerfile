FROM python:3.11-slim

# Build deps for any sdists in the mem0[graph] dependency tree.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8000

# Single worker: the mem0 Memory instance holds DB connections and is built once.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
