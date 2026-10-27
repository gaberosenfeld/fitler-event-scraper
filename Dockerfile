# Keep this tag EXACTLY aligned with package.json and package-lock.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
ENV NODE_ENV=production HEADLESS=true PORT=5174 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=pwuser:pwuser src ./src
USER pwuser
EXPOSE 5174
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
