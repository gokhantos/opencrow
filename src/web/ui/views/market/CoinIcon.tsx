import { useState } from "react";

const COIN_META: Record<string, { color: string; name: string }> = {
  BTC: { color: "#f7931a", name: "Bitcoin" },
  ETH: { color: "#627eea", name: "Ethereum" },
  SOL: { color: "#9945ff", name: "Solana" },
  BNB: { color: "#f3ba2f", name: "BNB" },
  XRP: { color: "#00aae4", name: "XRP" },
  DOGE: { color: "#c2a633", name: "Dogecoin" },
  ADA: { color: "#0033ad", name: "Cardano" },
  AVAX: { color: "#e84142", name: "Avalanche" },
};

const ICON_URLS: Record<string, string> = {
  BTC: "https://assets.coingecko.com/coins/images/1/small/bitcoin.png",
  ETH: "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
  SOL: "https://assets.coingecko.com/coins/images/4128/small/solana.png",
  BNB: "https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png",
  XRP: "https://assets.coingecko.com/coins/images/44/small/xrp-symbol-white-128.png",
  DOGE: "https://assets.coingecko.com/coins/images/5/small/dogecoin.png",
  ADA: "https://assets.coingecko.com/coins/images/975/small/cardano.png",
  AVAX: "https://assets.coingecko.com/coins/images/12559/small/Avalanche_Circle_RedWhite_Trans.png",
};

interface Props {
  readonly symbol: string;
  readonly size?: number;
}

export default function CoinIcon({ symbol, size = 24 }: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  const ticker = symbol.split("/")[0] ?? symbol;
  const meta = COIN_META[ticker];
  const url = ICON_URLS[ticker];
  const color = meta?.color ?? "#8e8a83";

  if (url && !imgFailed) {
    return (
      <img
        src={url}
        alt={ticker}
        width={size}
        height={size}
        className="shrink-0 align-middle rounded-full"
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <span
      className="shrink-0 inline-flex items-center justify-center rounded-full font-bold font-heading"
      style={{
        width: size,
        height: size,
        background: `${color}22`,
        color,
        fontSize: size * 0.45,
      }}
    >
      {ticker.charAt(0)}
    </span>
  );
}
