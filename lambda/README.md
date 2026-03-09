# Lambda: Checkout with Redis lock

Same checkout + lock + idempotency logic as the Express server, for API Gateway (HTTP API or REST API).

## Handler

- **File:** `lambda/checkout.js`
- **Export:** `handler`
- In AWS Lambda console: set **Handler** to `lambda/checkout.handler` (if the zip root is the project root).

## Environment variables (Lambda config)

| Variable | Example | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://your-elasticache.cache.amazonaws.com:6379` | **Required** in AWS. Use ElastiCache Redis endpoint. |
| `LOCK_TTL` | `10` | Lock TTL in seconds. |
| `IDEMPOTENCY_TTL` | `300` | Idempotency cache TTL in seconds. |

For **ElastiCache with encryption in transit**, use `rediss://` and ensure the Lambda VPC can reach the cluster.

## Deploy (example)

1. Zip the project (include `node_modules`, `lib`, `lambda`):
   ```bash
   cd distributed_lock_demo
   zip -r lambda.zip . -x "*.git*" -x ".env" -x "*.log"
   ```
2. Create a Lambda function (Node 18+), upload `lambda.zip`.
3. Set Handler to `lambda/checkout.handler`.
4. Set env vars: `REDIS_URL` (and optionally `LOCK_TTL`, `IDEMPOTENCY_TTL`).
5. If Redis is in a VPC, put the Lambda in the same VPC (and subnets/security group that can reach Redis).
6. Add API Gateway (HTTP or REST) and route `POST /checkout` (or `/api/checkout`) to this Lambda.

## Request (API Gateway proxy)

- **Method:** POST  
- **Body:** `{ "skuId": "SKU-001", "userId": "user-001" }`  
- **Header (optional):** `Idempotency-Key: <key>`

Response format is the same as the Express API (JSON body, 200 / 409 / 400 / 502).
