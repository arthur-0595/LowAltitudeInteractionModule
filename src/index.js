import * as Cesium from 'cesium';
import mitt from 'mitt';
// 引入Cesium的默认样式文件
const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = '/cesium/Widgets/widgets.css';
document.head.appendChild(link);
// 自定义样式
const style = document.createElement('style');
style.textContent = `
  .cesium-infoBox {
    top: 120px !important;
    left: 20px !important;
  }
`;
document.head.appendChild(style);

class LowAltitudeInteraction {
  /** @param {Object} [options] 配置项 */
  constructor(options = {}) {
    this.options = options; // 用户传入配置
    this.viewer = null; // Cesium.Viewer 实例
    this.entities = new Map(); // id -> Cesium.Entity
    this.primitiveMap = new Map(); // id -> Cesium.Primitive
    this.modelPositions = []; // 点位合集（不一定有用，先存着）
    this.emitter = mitt(); // 事件总线
    this._airspaceClick = null;
    this._fenceClick = null;
    this._lineClick = null;
    this._handler = null;
    this._frustumCullingTimeout = null;
    this._boundUpdateFrustumCulling = null; // 保存绑定的函数引用，用于移除事件监听器

    // 视锥剔除性能监控
    this._frustumCullingStats = {
      totalExecutions: 0,
      totalProcessedEntities: 0,
      totalCulledEntities: 0,
      totalDistanceCulledEntities: 0,
      averageExecutionTime: 0,
      lastExecutionTime: 0,
    };

    /* =========== 全局配置 & 部分优化策略 =========== */
    window.CESIUM_BASE_URL = options.basePath || '/cesium';
    // 同时发送的最大请求数量
    Cesium.RequestScheduler.maximumRequests = 50;
    // 同一服务器的最大并发请求数
    Cesium.RequestScheduler.maximumRequestsPerServer = 18;
    // 增加瓦片缓存数量
    Cesium.TileReplacementQueue.maximumLength = options.tileReplacementQueueMax || 2000;

    Cesium.Ion.defaultAccessToken = options.defaultAccessToken || '';

    // 视锥剔除配置
    this.frustumCullingConfig = {
      enabled: options.enableFrustumCulling !== false, // 默认启用
      debounceTime: options.frustumCullingDebounceTime || 200, // 防抖时间
      maxDistance: options.frustumCullingMaxDistance || 5000, // 最大处理距离
      baseRadius: options.frustumCullingBaseRadius || 25, // 基础边界球半径
      debug: options.debugFrustumCulling || false, // 调试模式
    };

    // Cesium.Camera.DEFAULT_VIEW_RECTANGLE = Cesium.Rectangle.fromDegrees(
    //   // 西边的经度
    //   89.5,
    //   // 南边的纬度
    //   22.5,
    //   // 东边的经度
    //   114.5,
    //   // 北边的纬度
    //   51.5,
    // );
  }

  /* =========== 事件封装 =========== */
  on(...args) {
    this.emitter.on(...args);
  } // cesium.on('ready', fn)
  off(...args) {
    this.emitter.off(...args);
  }
  emit(...args) {
    this.emitter.emit(...args);
  }

  /* =========== 初始化 Viewer =========== */
  /**
   * @param {string|HTMLElement} container 选择器或 DOM 节点
   * @returns {this}
   */
  init(container) {
    const el = typeof container === 'string' ? document.querySelector('#' + container) : container;

    if (!el) throw new Error('容器不存在');
    this.viewer = new Cesium.Viewer(container, {
      animation: false, // 动画控件
      timeline: false, // 时间轴
      geocoder: false, // 地址搜索框
      homeButton: false, // 回到初始视图
      sceneModePicker: false, // 场景模式切换按钮
      navigationHelpButton: false, // 帮助按钮
      selectionIndicator: false, // 实体选择指示器（即点击模型或地物时不会出现高亮或指示框）
      vrButton: false, // VR 按钮（即界面上不会显示进入虚拟现实模式的按钮）
      baseLayerPicker: false, // 底图图层控件显隐
      imageryProvider: false, // 不使用默认底图
      fullscreenButton: false, // 全屏按钮
      infoBox: true, // 控制是否显示实体的信息框,默认显示
      ...(this.options.viewer || {}),
    });
    // 去掉右下角版权
    this.viewer.cesiumWidget.creditContainer.style.display = 'none';
    // 关闭时间对光照的影响
    this.viewer.scene.globe.enableLighting = false;
    // 查看帧率
    this.viewer.scene.debugShowFramesPerSecond = this.options.showFramesPerSecond || false;

    // 根据配置决定是否启用视锥剔除
    if (this.frustumCullingConfig.enabled) {
      this._boundUpdateFrustumCulling = this._updateFrustumCulling.bind(this);
      this.viewer.camera.changed.addEventListener(this._boundUpdateFrustumCulling);
    }

    this.emit('ready', this.viewer);

    return this; // 支持链式
  }

  /* =========== 加载天地图影像 =========== */
  loadTdtImagery() {
    console.log('正在加载天地图影像...');
    try {
      // 影像类型img_w
      // 地形渲染ter_w
      const TDT_CONFIG = {
        key: this.options.tdtKey,
        imageType: 'img_w',
        maxLevel: 18,
      };

      let url = `https://t{s}.tianditu.gov.cn/DataServer?T=${TDT_CONFIG.imageType}&x={x}&y={y}&l={z}&tk=${TDT_CONFIG.key}`;

      const layerProvider = new Cesium.UrlTemplateImageryProvider({
        url: url,
        //  多级域名优化请求
        subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
        //  使用WEB墨卡托图块方案
        tilingScheme: new Cesium.WebMercatorTilingScheme(),
        //  缩放级别
        maximumLevel: TDT_CONFIG.maxLevel,
        //  添加版权信息
        credit: new Cesium.Credit('天地图', false),
        // 缓存配置
        enablePickFeatures: false, // 禁用拾取功能以提升性能
        hasAlphaChannel: false, // 如果图像没有透明通道，设为false可提升性能
        // rectangle: Cesium.Rectangle.fromDegrees(70, 10, 140, 55), // 限制加载范围
      });
      this.viewer.imageryLayers.addImageryProvider(layerProvider);

      console.log('天地图影像加载完成');
    } catch (error) {
      console.error('天地图影像加载失败:', error);
    }
  }

  /* =========== 加载3dtiles场景 =========== */
  async load3DTiles() {
    if (!this.viewer) throw new Error('请先调用 init()!');
    if (!this.options.tilesetUrl) throw new Error('请先配置 tilesetUrl!');
    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(
        //  余杭20平方公里
        this.options.tilesetUrl,

        {
          // =======⬇️⬇️⬇️3dtiles加载优化策略⬇️⬇️⬇️========
          // 内存缓存大小 256MB，默认512
          cacheBytes: 512 * 1024 * 1024,
          // 最大缓存溢出 64MB 默认128
          maximumCacheOverflowBytes: 128 * 1024 * 1024,
          // 视距越远自动放松精度
          dynamicScreenSpaceError: false,
          // 允许跳过中间层级，直接加载更高精度的瓦片，可显著提升加载速度，默认false
          skipLevelOfDetail: true,
          // 指定跳过的层级数量，默认1
          skipLevels: 1,
          // 屏幕空间误差阈值
          baseScreenSpaceError: 1024,
          maximumScreenSpaceError: 16, // 默认 16；数值越大，请求越少，画质稍降
          // 跳过屏幕空间误差因子
          // skipScreenSpaceErrorFactor 值的影响:
          // - 值越大(如32): 跳过更多层级,加载速度更快,但可能出现明显的LOD切换
          // - 值越小(如16): 层级切换更平滑,但加载稍慢,占用更多内存
          // - 建议范围: 8-32之间,根据实际效果和性能调整
          skipScreenSpaceErrorFactor: 16,
          // 立即加载目标精度层级
          // - true ：直接加载目标精度，可能有较长等待时间
          // - false ：渐进式加载，先显示低精度再逐步提升
          immediatelyLoadDesiredLevelOfDetail: false,
          // 加载兄弟节点
          // - true ：同时加载相邻区域的瓦片，预加载更多内容
          // - false ：只加载当前视野必需的瓦片
          loadSiblings: false,
          // 尽量直接请求叶子节点
          preferLeaves: true,
          // 移动时暂停请求
          cullRequestsWhileMoving: true,
          cullRequestsWhileMovingMultiplier: 10,
          // MB，限制缓存占用
          maximumMemoryUsage: 1024,
          // =======⬆️⬆️⬆️3dtiles加载优化策略⬆️⬆️⬆️==========
        },
      );

      this.viewer.scene.primitives.add(tileset);

      /* 根据包围球自动飞行到较远视角 */
      // await this.viewer.zoomTo(tileset, new Cesium.HeadingPitchRange(0, -0.6, tileset.boundingSphere.radius * 1.5));
      // await this.viewer.zoomTo(tileset);
    } catch (error) {
      console.error(`瓦片加载出现错误: ${error}`);
    }

    console.log('3dtiles场景加载完成');
  }

  /* =========== 批量加载模型 =========== */
  /**
   * @param {number} [count=1000]
   * @param {Array<Object>} [positions] 可传入自定义坐标
   * @example { id:'id-1', lon:120.1, lat:30.2, height:200, name:'飞机-1' }
   */
  async loadModels(count = 1000, positions) {
    if (!this.viewer) throw new Error('请先调用 init()!');
    console.log(`开始${positions ? '生成并' : ''}加载 ${count} 个模型点位...`);

    const list = positions || this._randomPositions(count);

    try {
      // 统计新增和更新的数量
      let newCount = 0;
      let updateCount = 0;

      // 批量处理模型实体
      let processedCount = 0;
      const batchSize = 200;

      const processBatch = (startIndex) => {
        const endIndex = Math.min(startIndex + batchSize, list.length);

        for (let i = startIndex; i < endIndex; i++) {
          const position = list[i];
          const positionId = position.id;

          // 将经纬度转换为Cesium的Cartesian3坐标
          const cartesianPosition = Cesium.Cartesian3.fromDegrees(
            position.longitude,
            position.latitude,
            position.height,
          );

          // ===⬇️⬇️检查是否已存在相同序号的实体，如果存在即更新，不存在则新增⬇️⬇️===
          if (this.entities.has(positionId)) {
            // 更新已有实体的位置
            const existingEntity = this.entities.get(positionId);
            // 修复：使用 ConstantPositionProperty 确保位置可以通过 getValue() 方法获取
            existingEntity.position = new Cesium.ConstantPositionProperty(cartesianPosition);

            // 更新标签文本
            existingEntity.label.text = position.name;

            // 更新描述信息
            existingEntity.description = `
              <div style="font-family: Arial, sans-serif; padding: 8px;">
                <h3 style="color: #2c3e50; margin-top: 0;">${position.name}</h3>
                <p><strong>序号:</strong> ${position.id}</p>
                <p><strong>经度:</strong> ${position.longitude}</p>
                <p><strong>纬度:</strong> ${position.latitude}</p>
                <p><strong>高度:</strong> ${position.height}</p>
                <p><strong>状态:</strong> 位置已更新</p>
                <p><strong>名称:</strong> ${position.name}</p>
              </div>
            `;

            updateCount++;
          } else {
            // 创建新的模型实体
            const modelEntity = this.viewer.entities.add({
              id: position.id,
              name: position.name,
              position: cartesianPosition,
              model: {
                uri: this.options.modelUri || '/cesium/model/fj.glb',
                minimumPixelSize: 32, // 减小最小像素大小以提高性能
                scale: Number(position.modelScale) || Number(this.options.modelScale) || 1,

                // ====模型简单上色，颜色混合，半透明====
                color: Cesium.Color.fromCssColorString(position.color || '#FFD700'), // 金色
                colorBlendMode: Cesium.ColorBlendMode.MIX,
                colorBlendAmount: position.colorBlendAmount || 0.67,

                // 禁用(DISABLED)阴影以提高性能，开启(ENABLED)
                shadows: Cesium.ShadowMode.DISABLED,
                heightReference: Cesium.HeightReference.NONE,
                // 是否运行模型动画,false表示禁用模型动画以提升性能
                runAnimations: false,
                // 🎯 添加模型距离显示条件, 0-10km范围内显示（与视锥剔除距离保持一致）
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5000),
              },
              label: {
                text: position.name,
                font: '12pt monospace',
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                outlineWidth: 1,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                // 设置标签偏移量 (x, y)
                // x: 0 表示水平居中
                // y: -20 表示向上偏移14像素
                pixelOffset: new Cesium.Cartesian2(0, -20),
                fillColor: Cesium.Color.CYAN,
                outlineColor: Cesium.Color.BLACK,
                showBackground: true,
                backgroundColor: new Cesium.Color(0.1, 0.1, 0.1, 0.5),
                scale: Number(position.labelScale) || Number(this.options.labelScale) || 0.6,
                // 🎯 添加模型标签距离显示条件, 0-2km范围内显示
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2000),
              },
              properties: {
                mark: position.mark,
              },
              description: `
                <div style="font-family: Arial, sans-serif; padding: 8px;">
                  <h3 style="color: #2c3e50; margin-top: 0;">${position.name}</h3>
                  <p><strong>序号:</strong> ${position.id}</p>
                  <p><strong>经度:</strong> ${position.longitude}</p>
                  <p><strong>纬度:</strong> ${position.latitude}</p>
                  <p><strong>高度:</strong> ${position.height}</p>
                  <p><strong>状态:</strong> 新创建</p>
                  <p><strong>名称:</strong> ${position.name}</p>
                </div>
              `,
            });

            // 将实体存储到Map中，以序号为键
            this.entities.set(positionId, modelEntity);
            newCount++;
          }

          processedCount++;
        }

        console.log(`已处理 ${processedCount}/${list.length} 个点位 (新增: ${newCount}, 更新: ${updateCount})`);

        // 继续处理下一批
        if (endIndex < list.length) {
          // 避免闭包捕获复杂对象，使用简单的递归调用
          const nextIndex = endIndex;
          setTimeout(() => {
            processBatch(nextIndex);
          }, 30);
        } else {
          // 全部处理完成
          console.log(`批量处理完成！`);
          console.log(`- 新增点位: ${newCount} 个`);
          console.log(`- 更新点位: ${updateCount} 个`);
          console.log(`- 总计点位: ${this.entities.size} 个`);

          // 更新全局点位数组
          this.modelPositions = list;

          // 位置更新完成后，手动触发一次视锥剔除以确保正确显示
          if (this.frustumCullingConfig.enabled) {
            setTimeout(() => {
              this._performFrustumCulling();
            }, 100); // 延迟100ms确保所有位置更新完成
          }
        }
      };

      // 开始分批处理
      processBatch(0);
    } catch (error) {
      console.error('加载模型时出错:', error);
    }
  }

  /* =========== 相机飞向指定坐标 =========== */
  flyTo(destination, orientation = { heading: 0, pitch: -45, roll: 0 }, duration = 2) {
    if (!this.viewer) throw new Error('请先调用 init()!');
    // 校验 destination 参数
    if (
      !destination ||
      typeof destination.longitude !== 'number' ||
      typeof destination.latitude !== 'number' ||
      typeof destination.height !== 'number' ||
      isNaN(destination.longitude) ||
      isNaN(destination.latitude) ||
      isNaN(destination.height)
    ) {
      throw new Error('destination 参数无效，必须包含经度、纬度和高度，且均为数字');
    }
    if (destination.height > 100000) {
      throw new Error('高度不能大于100000米');
    }
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(destination.longitude, destination.latitude, destination.height),
      orientation: {
        // Cesium.Math.toRadians 方法用于将角度值转换为弧度值
        heading: Cesium.Math.toRadians(orientation.heading), // heading：相机的航向角，0表示正北方向
        pitch: Cesium.Math.toRadians(orientation.pitch), // pitch：相机的俯仰角，-45表示向下俯视45度
        roll: Cesium.Math.toRadians(orientation.roll), // roll：相机的横滚角，0表示无侧倾
      },
      duration,
    });
  }

  /* =========== 飞向指定模型 && 相机跟踪 =========== */
  flyToModel(id, trackedEntity = true) {
    if (!this.viewer) throw new Error('请先调用 init()!');
    if (!this.modelPositions || this.modelPositions.length === 0) {
      console.warn('没有可飞向的模型');
      return;
    }
    const entity = this.entities.get(id);
    if (!entity) {
      console.warn(`未找到id为 ${id} 的模型，请检查序号是否正确`);
      return;
    }
    const { cameraHeight = 500, cameraHeading = 0, cameraPitch = -30, flyDuration = 1.5 } = this.options.flyToModel;

    const position = entity.position.getValue(this.viewer.clock.currentTime);
    if (position) {
      // 将笛卡尔坐标转换为地理坐标
      const cartographic = Cesium.Cartographic.fromCartesian(position);
      const longitude = Cesium.Math.toDegrees(cartographic.longitude);
      const latitude = Cesium.Math.toDegrees(cartographic.latitude);

      // 使用与双击事件相同的相机参数
      const customCameraOptions = {
        destination: Cesium.Cartesian3.fromDegrees(longitude, latitude - 0.008, cartographic.height + cameraHeight),
        orientation: {
          heading: Cesium.Math.toRadians(cameraHeading),
          pitch: Cesium.Math.toRadians(cameraPitch),
          roll: 0.0,
        },
        duration: flyDuration,
      };

      // 设置选中的实体，实现选中效果
      this.viewer.selectedEntity = entity;

      // 设置相机跟踪锁定到选中的实体
      this.viewer.trackedEntity = trackedEntity ? entity : undefined;

      // 执行相机飞行
      this.viewer.camera.flyTo(customCameraOptions);

      console.log(`通过id ${id} 选择模型 ${entity.name}，相机飞向目标位置`);
    }

    return this;
  }

  /* =========== 取消相机跟踪 =========== */
  cancelTracking() {
    if (!this.viewer) throw new Error('请先调用 init()!');
    this.viewer.trackedEntity = undefined;
    this.viewer.selectedEntity = undefined;
    console.log('已取消相机跟踪锁定，恢复自由相机控制');
    // 取消相机飞行动作
    // this.viewer.camera.cancelFlight();
    return this;
  }

  /* =========== 绘制执飞空域 =========== */
  drawAirspaces(areas, options = {}) {
    if (!this.viewer) throw new Error('请先调用 init()!');

    this._airspaceClick = options.onClick || function () {};
    this._initHandler();

    const entities = [];

    // —— 创建区域 ——
    areas.forEach((area, index) => {
      if (!area.points || area.points.length < 3) return;
      // 扁平化 [lon, lat, height, ...]
      const positions = area.points.flat();
      const color = this._parseColor(area.color, area.alpha || 0.4);
      // 在添加时判断id是否存在，如果存在，则删除，再添加新的
      // 此处因为空域数量不会太多所以这样处理，数量超过以前则需要别的解决方案
      const exists = this.viewer.entities.getById(area.id);
      if (exists) {
        this.viewer.entities.remove(exists);
      }
      let entity = null;
      // 走廊，通道型
      if (area.type == 'CORRIDOR') {
        entity = this.viewer.entities.add({
          id: area.id,
          name: area.id,
          corridor: {
            positions: Cesium.Cartesian3.fromDegreesArray(positions),
            material: color,
            outline: area.outline || false,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
            extrudedHeight: area.height,
            width: area.width || 100,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 30000), // 显示条件(距离)
          },
          properties: {
            id: area.id,
            type: area.type,
          },
          description: `
          <div style="font-family: Arial, sans-serif; padding: 8px;">
            <h3 style="color: #2c3e50; margin-top: 0;">${area.id}</h3>
            <p><strong>ID:</strong> ${area.id}</p>
            <p><strong>高度:</strong> ${area.height}</p>
          </div>
        `,
        });
      } else {
        entity = this.viewer.entities.add({
          id: area.id,
          name: area.id,
          polygon: {
            // 使用 holes 参数来定义多边形中的洞
            // 外部轮廓
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArrayHeights(positions),
              // 内部洞的轮廓数组
              area.holes?.map(
                (hole) => new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArrayHeights(hole.flat())),
              ),
            ),
            perPositionHeight: true, // 设置为 true 可以让多边形按照每个点的实际高度进行绘制,形成不规则的3D多边形
            material: color,
            outline: area.outline || false,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
            extrudedHeight: area.height,

            closeTop: area.hasTop || false,
            closeBottom: area.hasTop || false,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 30000), // 显示条件(距离)
          },
          properties: {
            id: area.id,
            type: area.type || 'AIRSPACE',
          },
          description: `
          <div style="font-family: Arial, sans-serif; padding: 8px;">
            <h3 style="color: #2c3e50; margin-top: 0;">${area.id}</h3>
            <p><strong>ID:</strong> ${area.id}</p>
            <p><strong>高度:</strong> ${area.height}</p>
          </div>
        `,
        });
      }

      entities.push(entity);
    });

    return entities;
  }

  /* =========== 绘制电子围栏 =========== */
  drawFence(areas, options = {}) {
    if (!this.viewer) throw new Error('请先调用 init()!');
    this._fenceClick = options.onClick || function () {};
    this._initHandler();

    const entities = [];
    const wallType = {
      1: {
        image: '/cesium/Assets/material/wall.png',
        color: Cesium.Color.BLUE,
      },
      2: {
        image: '/cesium/Assets/material/flyLine.png',
        color: Cesium.Color.RED,
      },
    };

    // —— 创建区域 ——
    areas.forEach((area, index) => {
      if (!area.points || area.points.length < 3) return;
      const positions = area.points.flat();
      // 在添加时判断id是否存在，如果存在，则删除，再添加新的
      const exists = this.viewer.entities.getById(area.id);
      if (exists) this.viewer.entities.remove(exists);
      const entity = this.viewer.entities.add({
        id: area.id,
        name: area.id,
        wall: {
          positions: Cesium.Cartesian3.fromDegreesArray(positions),
          maximumHeights: new Array(area.points.length).fill(area.height),
          minimunHeights: new Array(area.points.length).fill(0),
          // 动态材质
          material: new DynamicWallMaterialProperty({
            viewer: this.viewer,
            trailImage: area.wallType ? wallType[area.wallType].image : wallType[1].image,
            color: area.wallType ? wallType[area.wallType].color : wallType[1].color,
            duration: 2000,
          }),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 30000), // 显示条件(距离)
        },
        properties: {
          id: area.id,
          type: area.type || 'FENCE',
        },
        description: `
          <div style="font-family: Arial, sans-serif; padding: 8px;">
            <h3 style="color: #2c3e50; margin-top: 0;">${area.id}</h3>
            <p><strong>ID:</strong> ${area.id}</p>
            <p><strong>高度:</strong> ${area.height}</p>
            <p><strong>类型:</strong> 电子围栏</p>
          </div>
        `,
      });

      entities.push(entity);
    });

    return entities;
  }

  // 显示告警连接线
  /**
   * 批量绘制带文字的线条
   * @param {Array} array  配置数组，每项格式 ↓
   *   {
   *     id:        "line-001",            // 必填，业务 ID
   *     label:     "A → B 航线",          // 必填，文字
   *     pointA:    [lon, lat, height],    // 必填，起点
   *     pointB:    [lon, lat, height],    // 必填，终点
   *     color:     Cesium.Color.RED,      // 选填，默认黄色
   *     width:     2,                     // 选填，线宽
   *     flash:     true                   // 选填，是否闪烁
   *     type:      'LINE'                 // 选填，类型，默认LINE
   *   }
   * @param {Object} options  配置对象，可选
   * @returns {Array<Cesium.Entity>}  生成的实体数组
   */
  drawLabeledLines(array, options = {}) {
    if (!this.viewer) throw new Error('请先调用 init()!');

    const entities = [];

    // 工具：生成闪烁材质
    const createFlashMaterial = (color) => {
      // 回调让 alpha 在 0.2 ~ 1.0 之间循环
      const colorCallback = new Cesium.CallbackProperty(() => {
        const t = (Date.now() % 1000) / 1000; // 0-1
        const alpha = 0.2 + Math.abs(Math.sin(t * Math.PI)) * 0.7;
        return Cesium.Color.fromAlpha(color, alpha);
      }, false);
      return new Cesium.ColorMaterialProperty(colorCallback);
    };

    this._lineClick = options.onClick || function () {};
    this._initHandler();

    array.forEach((cfg) => {
      const { id, label, pointA, pointB, type = 'LINE', color = Cesium.Color.YELLOW, width = 2, flash = false } = cfg;

      // 两端三维坐标
      const positions = Cesium.Cartesian3.fromDegreesArrayHeights([...pointA, ...pointB]);
      // 中点，用于放文字
      const mid = Cesium.Cartesian3.midpoint(positions[0], positions[1], new Cesium.Cartesian3());

      // 线条材质：静态 or 闪烁
      const lineMaterial = flash
        ? createFlashMaterial(Cesium.Color[color])
        : new Cesium.ColorMaterialProperty(Cesium.Color[color]);

      // 在添加时判断id是否存在，如果存在，则删除，再添加新的
      // 此处因为空域数量不会太多所以这样处理，数量超过以前则需要别的解决方案
      const exists = this.viewer.entities.getById(id);
      if (exists) {
        this.viewer.entities.remove(exists);
      }

      const entity = this.viewer.entities.add({
        id,
        polyline: {
          positions,
          material: lineMaterial,
          width,
          clampToGround: false,
        },
        label: {
          text: label,
          font: '13px sans-serif',
          // fillColor: Cesium.Color.WHITE,
          fillColor: Cesium.Color[color], // 此处设置为跟线条颜色一致
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.4),
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -10),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 30000), // 设置标签的可见距离范围
        },
        position: mid,
        properties: { id, flashFlag: flash, type: type || 'LINE' },
        description: `
          <div style="font-family: Arial, sans-serif; padding: 8px;">
          <h3 style="color: #2c3e50; margin-top: 0;">${id}</h3>
          <p><strong>ID:</strong> ${id}</p>
          <p><strong>描述:</strong> ${label}</p>
          <p><strong>宽度:</strong> ${width}</p>
          <p><strong>pointA:</strong> ${pointA}</p>
          <p><strong>pointB:</strong> ${pointB}</p>
        </div>
      `,
      });

      entities.push(entity);
    });

    return entities;
  }

  // 显示飞机飞行轨迹线条

  /**
   * 高性能多段材质线条渲染
   * @param {Array} linesData - 线条数据数组
   * @returns {Cesium.Primitive} 返回创建的Primitive对象
   */
  drawPolylines(polylines, id) {
    if (!this.viewer) throw new Error('请先调用 init()!');

    // 参数校验：id
    if (!id || (typeof id !== 'string' && typeof id !== 'number')) {
      throw new Error('参数 id 必须是非空字符串或数字');
    }

    // 检查 id 是否已存在
    if (!this.primitiveMap) {
      this.primitiveMap = new Map();
    }

    // 参数校验：polylines
    if (!Array.isArray(polylines)) {
      throw new Error('参数 polylines 必须是数组类型');
    }

    if (polylines.length === 0) {
      console.warn('drawPolylines: polylines 为空数组，无需绘制');
      return;
    }

    // 参数校验：检查每个线条配置项的必要字段
    const invalidItems = [];
    polylines.forEach((line, index) => {
      if (!line || typeof line !== 'object') {
        invalidItems.push(`索引 ${index}: 线条配置项必须是对象`);
        return;
      }

      // 校验 positions 字段
      if (!Array.isArray(line.positions)) {
        invalidItems.push(`索引 ${index}: positions 字段必须是数组`);
      } else if (line.positions.length === 0) {
        invalidItems.push(`索引 ${index}: positions 数组不能为空`);
      } else {
        // 检查 positions 数组中的每个点
        line.positions.forEach((point, pointIndex) => {
          if (!Array.isArray(point) || point.length !== 3) {
            invalidItems.push(`索引 ${index}, 点 ${pointIndex}: 坐标点必须是包含3个元素的数组 [经度, 纬度, 高度]`);
          }
        });
      }

      // 校验 segmentColors 字段
      if (!Array.isArray(line.segmentColors)) {
        invalidItems.push(`索引 ${index}: segmentColors 字段必须是数组`);
      } else if (line.segmentColors.length === 0) {
        invalidItems.push(`索引 ${index}: segmentColors 数组不能为空`);
      } else {
        // 检查颜色配置
        line.segmentColors.forEach((colorConfig, colorIndex) => {
          if (!colorConfig || typeof colorConfig !== 'object') {
            invalidItems.push(`索引 ${index}, 颜色 ${colorIndex}: 颜色配置必须是对象`);
          } else {
            if (!colorConfig.color) {
              invalidItems.push(`索引 ${index}, 颜色 ${colorIndex}: color 字段不能为空`);
            }
            if (
              colorConfig.alpha !== undefined &&
              (typeof colorConfig.alpha !== 'number' || colorConfig.alpha < 0 || colorConfig.alpha > 1)
            ) {
              invalidItems.push(`索引 ${index}, 颜色 ${colorIndex}: alpha 值必须是 0-1 之间的数字`);
            }
          }
        });
      }

      // 校验 width 字段（可选）
      if (line.width !== undefined && (typeof line.width !== 'number' || line.width <= 0)) {
        invalidItems.push(`索引 ${index}: width 字段必须是大于0的数字`);
      }
    });

    if (invalidItems.length > 0) {
      throw new Error(`drawPolylines 参数校验失败:\n${invalidItems.join('\n')}`);
    }

    // 此处如果id重复，则直接调用删除命令删除旧线条
    if (this.primitiveMap.has(id)) {
      this.deletePolylines(id);
    }

    const geometryInstances = [];

    polylines.forEach((line, index) => {
      const { positions, segmentColors, width = 3 } = line;

      const points = positions.flat();
      // 处理颜色数组，支持十六进制和混合比例
      const processedColors = segmentColors.map((item) => this._parseColor(item.color || '#ffffff', item.alpha || 1.0));

      // 为每个线条创建几何实例
      const geometryInstance = new Cesium.GeometryInstance({
        id: `line_${index}`,
        geometry: new Cesium.PolylineGeometry({
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(points),
          colors: processedColors, // 使用处理后的颜色数组
          width: width,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        }),
      });

      geometryInstances.push(geometryInstance);
    });

    // 创建单个Primitive包含所有线条
    const primitive = new Cesium.Primitive({
      geometryInstances: geometryInstances,
      appearance: new Cesium.PolylineColorAppearance(),
      asynchronous: true, // 异步创建，避免阻塞主线程
      id,
    });
    console.log(11);

    const addedPrimitive = this.viewer.scene.primitives.add(primitive);
    this.primitiveMap.set(id, addedPrimitive);
  }

  /* =========== 删除指定移除 Primitive =========== */
  /**
   * @param {string} id
   * @returns {boolean} 成功 or 失败
   */
  deletePolylines(id) {
    if (this.primitiveMap && this.primitiveMap.has(id)) {
      const primitive = this.primitiveMap.get(id);
      this.viewer.scene.primitives.remove(primitive);
      this.primitiveMap.delete(id);
      return true;
    }
    return false;
  }

  /* =========== 删除指定实体 =========== */
  /**
   * @param {string[]} ids
   */
  deleteByIds(ids = []) {
    if (!Array.isArray(ids) || ids.length === 0) {
      console.warn('deleteByIds: 请提供有效的模型ID数组');
      return { success: false, message: '无效的模型ID数组' };
    }

    console.log(`开始删除模型，ID列表:`, ids);

    let deletedCount = 0;
    let notFoundCount = 0;
    const deletedIds = [];
    const notFoundIds = [];

    ids.forEach((id) => {
      // 首先尝试从 this.entities Map 中查找（普通模型点位）
      if (this.entities.has(id)) {
        const entity = this.entities.get(id);

        this.viewer.entities.remove(entity);
        this.entities.delete(id);
        const positionIndex = this.modelPositions.findIndex((pos) => pos.id.toString() === id.toString());
        if (positionIndex !== -1) {
          this.modelPositions.splice(positionIndex, 1);
        }

        deletedCount++;
        deletedIds.push(id);
        console.log(`✓ 已删除模型: ${id}`);
      } else {
        // 尝试通过实体名称或属性查找（空域、围栏等特殊实体）
        const entities = this.viewer.entities.values;

        let found = false;

        for (let i = 0; i < entities.length; i++) {
          const entity = entities[i];

          // 检查实体名称是否包含目标ID
          if (entity.id && entity.id.toString().includes(id.toString())) {
            this.viewer.entities.remove(entity);
            deletedCount++;
            deletedIds.push(id);
            found = true;
            console.log(`✓ 已删除实体: ${entity.id} (匹配ID: ${id})`);
            break;
          }
        }

        if (!found) {
          notFoundCount++;
          notFoundIds.push(id);
          console.warn(`✗ 未找到模型: ${id}`);
        }
      }
    });

    console.log(`删除完成，共删除 ${deletedCount} 个模型，未找到 ${notFoundCount} 个模型`);
    return this;
  }

  /* =========== 清除所有模型 =========== */
  clearAllModels() {
    console.log('清除所有模型点位...');

    // 清除所有实体
    this.viewer.entities.removeAll();

    // 清除所有 Primitive
    this.primitiveMap.forEach((primitive) => {
      this.viewer.scene.primitives.remove(primitive);
    });
    this.primitiveMap.clear();

    // 重置点位数组和实体Map
    this.modelPositions = [];
    this.entities.clear();

    console.log('已清除所有模型点位，实体Map已重置');
  }

  /* =========== Cesium 销毁释放 =========== */
  /**
   * 销毁实例，清理所有资源
   * 包括相机事件监听器、定时器、实体等
   */
  destroy() {
    try {
      // 清理视锥剔除定时器
      if (this._frustumCullingTimeout) {
        clearTimeout(this._frustumCullingTimeout);
        this._frustumCullingTimeout = null;
      }

      // 清理相机事件监听器
      if (this.viewer && this.viewer.camera && this._boundUpdateFrustumCulling) {
        this.viewer.camera.changed.removeEventListener(this._boundUpdateFrustumCulling);
        this._boundUpdateFrustumCulling = null;
      }

      // 清理事件处理器
      if (this._handler) {
        this._handler.destroy();
        this._handler = null;
      }

      // 清理实体和位置数据
      this.entities.clear();
      this.modelPositions = [];
      this.primitiveMap.clear();

      // 清理事件发射器
      this.emitter.all.clear();

      // 销毁viewer
      if (this.viewer) {
        this.viewer.destroy();
        this.viewer = null;
      }

      console.log('Cesium 实例销毁完成，所有资源已清理');
    } catch (error) {
      console.error('销毁实例时出错:', error);
    }
  }

  /* =========== 工具：生成随机点 =========== */
  _randomPositions(count) {
    const list = [];
    const bounds = {
      minLon: 119.956752,
      maxLon: 120.031154,
      minLat: 30.266192,
      maxLat: 30.303925,
      minH: 50,
      maxH: 1000,
    };

    for (let i = 0; i < count; i++) {
      const lon = bounds.minLon + Math.random() * (bounds.maxLon - bounds.minLon);
      const lat = bounds.minLat + Math.random() * (bounds.maxLat - bounds.minLat);
      const h = bounds.minH + Math.random() * (bounds.maxH - bounds.minH);
      const id = `id-${i + 1}`;
      list.push({
        id,
        longitude: +lon.toFixed(6),
        latitude: +lat.toFixed(6),
        height: Math.round(h),
        name: `杭州点位_${String(i + 1).padStart(4, '0')}`,
        mark: id,
      });
    }
    return list;
  }

  /* =========== 工具：生成cesium 颜色 =========== */
  /**
   * 十六进制颜色转Cesium颜色工具函数
   * @param {string|Cesium.Color} color - 颜色值，支持十六进制字符串或Cesium.Color对象
   * @param {number} alpha - 透明度/混合比例，范围0-1，默认1.0
   * @returns {Cesium.Color} 返回Cesium颜色对象
   */
  _parseColor(color, alpha = 1.0) {
    if (color instanceof Cesium.Color) {
      return color.withAlpha(alpha);
    }

    if (typeof color === 'string') {
      // 处理十六进制颜色字符串
      if (color.startsWith('#')) {
        return Cesium.Color.fromCssColorString(color).withAlpha(alpha);
      }
      // 处理CSS颜色名称
      return Cesium.Color.fromCssColorString(color).withAlpha(alpha);
    }

    // 默认返回白色
    return Cesium.Color.WHITE.withAlpha(0.6);
  }

  /**
   * 更新视锥剔除（防抖处理）
   * @private
   */
  _updateFrustumCulling() {
    // 清除之前的定时器
    if (this._frustumCullingTimeout) {
      clearTimeout(this._frustumCullingTimeout);
    }

    // 设置新的定时器，延迟执行视锥剔除
    this._frustumCullingTimeout = setTimeout(() => {
      this._performFrustumCulling();
    }, this.frustumCullingConfig.debounceTime);
  }

  /**
   * 执行视锥剔除优化
   * 添加距离检查和性能优化
   * @private
   */
  _performFrustumCulling() {
    try {
      if (!this.viewer || this.entities.size === 0) {
        return;
      }

      const camera = this.viewer.camera;
      const cameraPosition = camera.position;
      const frustum = camera.frustum;
      const cullingVolume = frustum.computeCullingVolume(cameraPosition, camera.direction, camera.up);
      const currentTime = this.viewer.clock.currentTime;

      // 性能优化：使用配置的最大处理距离
      const maxCullingDistance = this.frustumCullingConfig.maxDistance;
      const maxCullingDistanceSquared = maxCullingDistance * maxCullingDistance;

      // 性能监控：记录开始时间
      const startTime = performance.now();

      // 性能计数器
      let processedCount = 0;
      let culledCount = 0;
      let distanceCulledCount = 0;

      this.entities.forEach((entity, entityId) => {
        try {
          // 🎯 特殊处理：被跟踪或选中的实体始终保持可见
          const isTrackedEntity = this.viewer.trackedEntity === entity;
          const isSelectedEntity = this.viewer.selectedEntity === entity;
          if (isTrackedEntity || isSelectedEntity) {
            if (entity.show !== true) {
              entity.show = true;
            }
            processedCount++;
            return;
          }

          // 获取实体位置
          const position = entity.position?.getValue(currentTime);
          if (!position) {
            return;
          }

          // 距离检查优化：计算相机到实体的距离
          const distanceSquared = Cesium.Cartesian3.distanceSquared(cameraPosition, position);

          // 如果距离超过最大剔除距离，直接隐藏
          if (distanceSquared > maxCullingDistanceSquared) {
            if (entity.show !== false) {
              entity.show = false;
              distanceCulledCount++;
            }
            return;
          }

          // 动态边界球半径：根据模型缩放和距离调整
          const modelScale = entity.model?.scale?.getValue(currentTime) || 1;
          const baseRadius = this.frustumCullingConfig.baseRadius;
          const scaledRadius = baseRadius * (typeof modelScale === 'number' ? modelScale : 1);

          // 根据距离调整边界球大小（远处的模型可以用更小的边界球）
          const distance = Math.sqrt(distanceSquared);
          const distanceFactor = Math.min(1, distance / 1000); // 1公里内保持原始大小
          const finalRadius = scaledRadius * (1 + distanceFactor * 0.5);

          const boundingSphere = new Cesium.BoundingSphere(position, finalRadius);

          // 视锥剔除检查
          const visibility = cullingVolume.computeVisibility(boundingSphere);
          const shouldShow = visibility !== Cesium.Intersect.OUTSIDE;

          // 只在状态改变时更新显示属性，减少不必要的操作
          if (entity.show !== shouldShow) {
            entity.show = shouldShow;
            if (!shouldShow) {
              culledCount++;
            }
          }

          processedCount++;
        } catch (entityError) {
          console.warn(`处理实体 ${entityId} 时出错:`, entityError);
        }
      });

      // 性能监控：更新统计数据
      const executionTime = performance.now() - startTime;
      this._updateFrustumCullingStats(processedCount, culledCount, distanceCulledCount, executionTime);

      // 性能日志（仅在调试模式下输出）
      if (this.frustumCullingConfig.debug) {
        const visibleCount = processedCount - culledCount - distanceCulledCount;
        console.log(
          `视锥剔除完成: 处理${processedCount}个实体, 可见${visibleCount}个, 视锥剔除${culledCount}个, 距离剔除${distanceCulledCount}个, 耗时${executionTime.toFixed(
            2,
          )}ms`,
        );

        // 如果没有可见模型，输出警告
        if (visibleCount === 0 && processedCount > 0) {
          console.warn('⚠️ 当前视野内没有可见模型，可能的原因：');
          console.warn('1. 相机距离过远（超过10公里）');
          console.warn('2. 所有模型都在视锥外');
          console.warn('3. 模型位置更新后未正确设置');
          console.warn('建议：调整相机位置或检查模型坐标');
        }
      }
    } catch (error) {
      console.error('视锥剔除执行出错:', error);
    }
  }

  /**
   * 更新视锥剔除性能统计
   * @param {number} processedCount - 处理的实体数量
   * @param {number} culledCount - 被视锥剔除的实体数量
   * @param {number} distanceCulledCount - 被距离剔除的实体数量
   * @param {number} executionTime - 执行时间（毫秒）
   * @private
   */
  _updateFrustumCullingStats(processedCount, culledCount, distanceCulledCount, executionTime) {
    const stats = this._frustumCullingStats;

    stats.totalExecutions++;
    stats.totalProcessedEntities += processedCount;
    stats.totalCulledEntities += culledCount;
    stats.totalDistanceCulledEntities += distanceCulledCount;
    stats.lastExecutionTime = executionTime;

    // 计算平均执行时间
    stats.averageExecutionTime =
      (stats.averageExecutionTime * (stats.totalExecutions - 1) + executionTime) / stats.totalExecutions;
  }

  /* =========== 事件处理器 =========== */
  _initHandler() {
    if (this._handler) {
      this._handler.destroy();
      this._handler = null;
    }
    this._handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this._handler.setInputAction((click) => {
      const picked = this.viewer.scene.pick(click.position);
      const entity = picked && picked.id;
      if (entity && entity.properties && entity.properties.id) {
        const id = entity.properties.id.getValue(this.viewer.clock.currentTime);
        const type =
          entity.properties.type && entity.properties.type.getValue
            ? entity.properties.type.getValue(this.viewer.clock.currentTime)
            : entity.properties.type;

        if (type === 'FENCE') {
          this._fenceClick && this._fenceClick(id);
        } else if (type === 'AIRSPACE') {
          this._airspaceClick && this._airspaceClick(id);
        } else if (type === 'LINE') {
          this._lineClick && this._lineClick(id);
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
}

// 动态墙材质配置常量
const DYNAMIC_WALL_CONSTANTS = {
  // 默认配置
  DEFAULT_OPTIONS: {
    color: new Cesium.Color(1.0, 1.0, 1.0, 1.0),
    duration: 3000,
    trailImage: '',
    count: 3.0,
    direction: '-', // "+":由下到上  "-":由上到下
    freely: 'vertical',
  },
  // 动画方向枚举
  ANIMATION_DIRECTION: {
    VERTICAL: 'vertical',
    HORIZONTAL: 'horizontal',
  },
  // 时间方向枚举
  TIME_DIRECTION: {
    FORWARD: '+',
    BACKWARD: '-',
  },
};

/**
 * 动态墙材质属性类
 * 用于创建具有动态效果的墙体材质，支持垂直和水平方向的动画效果
 */
class DynamicWallMaterialProperty {
  /**
   * 构造函数
   * @param {Object} options - 配置选项
   * @param {Cesium.Color} options.color - 材质颜色
   * @param {number} options.duration - 动画持续时间（毫秒）
   * @param {string} options.trailImage - 纹理图像路径
   * @param {Cesium.Viewer} options.viewer - Cesium视图对象
   */
  constructor(options = {}) {
    // 参数验证
    this._validateOptions(options);

    // 合并默认配置
    const config = { ...DYNAMIC_WALL_CONSTANTS.DEFAULT_OPTIONS, ...options };

    // 初始化属性
    this._definitionChanged = new Cesium.Event();
    this._color = undefined;
    this._colorSubscription = undefined;
    this._startTime = performance.now(); // 使用高精度时间戳
    this._viewer = config.viewer;

    // 设置公共属性
    this.color = config.color;
    this.duration = config.duration;
    this.trailImage = config.trailImage;

    // 性能优化：缓存渲染请求
    this._lastRenderTime = 0;
    this._renderThrottle = 16; // 约60fps
  }

  /**
   * 验证构造函数参数
   * @private
   * @param {Object} options - 配置选项
   */
  _validateOptions(options) {
    if (!options.viewer || !options.viewer.scene) {
      throw new Error('DynamicWallMaterialProperty: viewer参数是必需的');
    }

    if (options.duration && (typeof options.duration !== 'number' || options.duration <= 0)) {
      console.warn('DynamicWallMaterialProperty: duration应为正数，使用默认值');
    }
  }

  /**
   * 获取材质类型
   * @param {Cesium.JulianDate} time - 当前时间
   * @returns {string} 材质类型标识
   */
  getType(time) {
    return MaterialType;
  }

  /**
   * 获取材质属性值
   * @param {Cesium.JulianDate} time - 当前时间
   * @param {Object} result - 结果对象
   * @returns {Object} 材质属性对象
   */
  getValue(time, result) {
    if (!Cesium.defined(result)) {
      result = {};
    }

    // 获取颜色属性
    result.color = Cesium.Property.getValueOrClonedDefault(this._color, time, Cesium.Color.WHITE, result.color);

    // 设置纹理图像
    result.image = this.trailImage;

    // 计算时间进度（优化性能）
    if (this.duration) {
      const currentTime = performance.now();
      const elapsed = currentTime - this._startTime;
      result.time = (elapsed % this.duration) / this.duration;
    }

    // 节流渲染请求以提高性能
    this._throttledRender();

    return result;
  }

  /**
   * 节流渲染请求
   * @private
   */
  _throttledRender() {
    const now = performance.now();
    if (now - this._lastRenderTime >= this._renderThrottle) {
      this._viewer.scene.requestRender();
      this._lastRenderTime = now;
    }
  }

  /**
   * 比较两个材质属性对象是否相等
   * @param {DynamicWallMaterialProperty} other - 另一个材质属性对象
   * @returns {boolean} 是否相等
   */
  equals(other) {
    return (
      this === other ||
      (other instanceof DynamicWallMaterialProperty &&
        Cesium.Property.equals(this._color, other._color) &&
        this.duration === other.duration &&
        this.trailImage === other.trailImage)
    );
  }

  /**
   * 销毁资源
   */
  destroy() {
    if (this._colorSubscription) {
      this._colorSubscription();
      this._colorSubscription = undefined;
    }
    this._definitionChanged = undefined;
    this._viewer = undefined;
  }
}

/**
 * 生成动态墙体着色器代码
 * @param {Object} options - 着色器配置选项
 * @param {boolean} options.get - 是否生成着色器
 * @param {number} options.count - 重复次数
 * @param {string} options.freely - 动画方向（'vertical' 或 'horizontal'）
 * @param {string} options.direction - 时间方向（'+' 或 '-'）
 * @returns {string} 着色器源码
 */
function _getDirectionWallShader(options = {}) {
  // 参数验证
  if (!options || !options.get) {
    console.warn('_getDirectionWallShader: 无效的选项参数');
    return '';
  }

  // 默认配置
  const config = {
    count: options.count || 3.0,
    freely: options.freely || DYNAMIC_WALL_CONSTANTS.ANIMATION_DIRECTION.VERTICAL,
    direction: options.direction || DYNAMIC_WALL_CONSTANTS.TIME_DIRECTION.FORWARD,
  };

  // 着色器基础结构
  const shaderBase = `
    czm_material czm_getMaterial(czm_materialInput materialInput) {
      // 获取默认材质实例
      czm_material material = czm_getDefaultMaterial(materialInput);
      // 获取纹理坐标
      vec2 st = materialInput.st;
  `;

  // 根据动画方向生成纹理采样代码
  let textureCode = '';
  if (config.freely === DYNAMIC_WALL_CONSTANTS.ANIMATION_DIRECTION.VERTICAL) {
    // 垂直方向动画：st.t随时间变化，st.s保持不变
    textureCode = `
      vec4 colorImage = texture(image, vec2(
        fract(st.s), 
        fract(float(${config.count}) * st.t ${config.direction} time)
      ));
    `;
  } else {
    // 水平方向动画：st.s随时间变化，st.t保持不变
    textureCode = `
      vec4 colorImage = texture(image, vec2(
        fract(float(${config.count}) * st.s ${config.direction} time), 
        fract(st.t)
      ));
    `;
  }

  // 泛光效果和最终输出
  const shaderEnd = `
      // 计算泛光效果
      vec4 fragColor;
      fragColor.rgb = (colorImage.rgb + color.rgb) / 1.0;
      fragColor = czm_gammaCorrect(fragColor);
      
      // 设置材质属性
      material.diffuse = colorImage.rgb;
      material.alpha = colorImage.a;
      material.emission = fragColor.rgb;
      
      return material;
    }
  `;

  return shaderBase + textureCode + shaderEnd;
}

// 定义材质属性描述符
Object.defineProperties(DynamicWallMaterialProperty.prototype, {
  /**
   * 材质是否为常量（动态材质始终返回false）
   */
  isConstant: {
    get: function () {
      return false;
    },
  },
  /**
   * 定义变更事件
   */
  definitionChanged: {
    get: function () {
      return this._definitionChanged;
    },
  },
  /**
   * 颜色属性描述符
   */
  color: Cesium.createPropertyDescriptor('color'),
});

// 生成唯一的材质类型标识
const MaterialType = `dynamicWall_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

// 注册材质到Cesium材质缓存
Cesium.Material._materialCache.addMaterial(MaterialType, {
  fabric: {
    type: MaterialType,
    uniforms: {
      color: DYNAMIC_WALL_CONSTANTS.DEFAULT_OPTIONS.color.clone(),
      image: DYNAMIC_WALL_CONSTANTS.DEFAULT_OPTIONS.trailImage,
      time: 0.0,
    },
    source: _getDirectionWallShader({
      get: true,
      count: DYNAMIC_WALL_CONSTANTS.DEFAULT_OPTIONS.count,
      freely: DYNAMIC_WALL_CONSTANTS.DEFAULT_OPTIONS.freely,
      direction: DYNAMIC_WALL_CONSTANTS.DEFAULT_OPTIONS.direction,
    }),
  },
  /**
   * 确定材质是否为半透明
   * @param {Cesium.Material} material - 材质对象
   * @returns {boolean} 是否半透明
   */
  translucent: function (material) {
    return true;
  },
});

export default LowAltitudeInteraction;
