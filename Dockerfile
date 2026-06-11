FROM public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 AS adapter
FROM public.ecr.aws/lambda/nodejs:22

COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter

ENV PORT=3000
ENV AWS_LWA_READINESS_CHECK_PATH=/api/comments/history

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# AWS 管理ベースイメージは CMD を handler 名として解釈するため ENTRYPOINT で起動する
ENTRYPOINT ["node", "server.js"]
