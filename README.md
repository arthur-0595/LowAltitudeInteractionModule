# cesium-engine

## 简介
封装好的 Cesium 场景 SDK，支持低空交互、批量模型加载、天地图影像等。

## 安装
```bash
npm install cesium-engine
```

## 使用示例
```js
import LowAltitudeInteraction from 'cesium-engine';

const sdk = new LowAltitudeInteraction({
  tdtKey: '你的天地图key',
  tilesetUrl: '3dtiles服务地址',
  defaultAccessToken: '你的Cesium Ion Token'
});

sdk.init('cesiumContainer');
sdk.loadTdtImagery();
sdk.load3DTiles();
```

## API
- `init(container)` 初始化Cesium Viewer
- `loadTdtImagery()` 加载天地图影像
- `load3DTiles()` 加载3dtiles场景
- `loadModels(count, positions)` 批量加载模型

## 构建与测试
```bash
npm run build
npm test
```

---
如需详细API或定制功能，请联系作者。