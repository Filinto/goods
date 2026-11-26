# Cesto — Lista de Compras

Uma aplicação de compras mobile-first, criada com React, TypeScript e Vite. Fotografe uma etiqueta de preço com a câmara do telemóvel, confirme ou edite os dados reconhecidos e acompanhe uma estimativa do total.

## Executar localmente

1. Instale o Node.js (20.19+ ou 22.12+).
2. Execute `npm install`.
3. Execute `npm run dev` e abra o endereço local no computador ou telemóvel. Para testar no telemóvel, o servidor tem de estar acessível na rede local; o acesso à câmara requer HTTPS ou localhost.
4. No telemóvel, toque em **Digitalizar etiqueta de preço** e permita o acesso à câmara. Também pode escolher uma fotografia existente.

Use `npm run build` para criar uma versão de produção e `npm run lint` para executar o linter.

## Funcionalidades

- Ecrãs de criação de conta e início de sessão para demonstração local.
- Captura de fotografia e reconhecimento de texto (OCR) no navegador, com Tesseract.js em português.
- Confirmação dos dados reconhecidos: nome do artigo, preço, preço por kg e quantidade antes de adicionar à lista.
- Lista de compras, controlo de quantidades, total estimado, histórico de compras concluídas e criação de novas listas.
- Interface responsiva para telemóvel e computador e uma versão PWA instalável básica.
- Formatos de data e moeda de Portugal (EUR).

## Limitações do protótipo

- **As contas são apenas para demonstração e ficam neste dispositivo.** O e-mail e um hash da palavra-passe com salt são guardados no armazenamento do navegador. Não existe servidor, autenticação segura, recuperação de palavra-passe nem sincronização entre dispositivos. É necessário integrar um backend de autenticação antes de usar em produção.
- As listas e fotografias comprimidas ficam no localStorage do navegador, neste dispositivo. A limpeza dos dados do navegador apaga essa informação e o espaço disponível é limitado.
- O OCR é uma estimativa e pode exigir a transferência inicial do modelo de idioma. Confirme sempre os dados antes de adicionar um artigo. O total apresentado está em euros e não inclui descontos nem impostos.
- O service worker é registado nas versões de produção. O OCR pode precisar de ligação à Internet se o modelo ainda não tiver sido transferido.

## Publicar em semprecerto.com

O projeto é uma aplicação Vite estática. O Squarespace gere o domínio, mas não publica diretamente esta aplicação React; a publicação está configurada através do GitHub Pages. O workflow em `.github/workflows/deploy.yml` compila e publica cada atualização enviada para `main`, e `public/CNAME` define o domínio personalizado.

Para concluir a configuração:

1. No GitHub, abra as definições do repositório, aceda a **Pages** e selecione **GitHub Actions** como origem da publicação.
2. No Squarespace, abra as definições DNS de `semprecerto.com` e adicione estes registos para o domínio raiz:
   - A — Host `@` — `185.199.108.153`
   - A — Host `@` — `185.199.109.153`
   - A — Host `@` — `185.199.110.153`
   - A — Host `@` — `185.199.111.153`
   - CNAME — Host `www` — `Filinto.github.io`
3. Remova registos A ou CNAME existentes para `@`/`www` que apontem para outro alojamento, se já não forem necessários. Não altere registos MX nem outros registos de e-mail.
4. Depois de o DNS propagar e o primeiro workflow publicar o site, confirme `semprecerto.com` como domínio personalizado nas definições **Pages** do GitHub e ative **Enforce HTTPS** quando ficar disponível.

A propagação DNS pode demorar. O acesso à câmara exige HTTPS; não partilhe credenciais nem dados reais enquanto a autenticação e o armazenamento forem apenas demonstrações locais.
