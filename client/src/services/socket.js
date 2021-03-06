import Vue from 'vue'
import Axios from 'axios'

import options from './options'

const emitter = new Vue({
  data() {
    return {
      url: process.env.API_URL || 'ws://localhost:3000',
      delay: 0,
      trades: [],
      exchanges: [],
      lastExchangesPrices: {},
      socket: null,
      connected: false,
      reconnectionDelay: 2000,
    }
  },
  created() {
    this.http_url = this.url.replace(/^ws(s?)\:\/\//, 'http$1://');
  },
  methods: {
    connect() {
      if (this.socket && this.socket.readyState === 1) {
        return;
      }

      this.socket = new WebSocket(this.url);

      this.socket.onopen = event => {
        this.connected = true;

        this.$emit('connected', event);

        this.$emit('price', '???', 'neutral')

        this.reconnectionDelay = 5000;
      }

      this.socket.onmessage = event => {
        let data = JSON.parse(event.data);

        if (!data) {
          throw new Error('Unable to read socket message');
        }

        if (Array.isArray(data) && data.length) {

          /* received message is trade data
              => filter, sort, store and transmit to components
          */

          data = data
            .sort((a, b) => a[1] - b[1]);

          if (this.delayed) {
            for (let i=0; i<data.length; i++) {
              data[i][1] -= this.delay;
            }
          }

          this.trades = this.trades.concat(data);

          this.$emit('trades', data);

        } else if (typeof data.type) {

          /* received message is something else
              => event, alerts, updates..
          */

          switch (data.type) {
            case 'welcome':
              this.$emit('welcome', data);

              if (data.admin) {
                this.$emit('admin');
              }

              this.exchanges = data.exchanges
                .filter(exchange => exchange.connected)
                .map(exchange => exchange.id);

              this.delay = data.timestamp ? data.timestamp - +new Date() : 0;
              this.delayed = Math.abs(this.delay) > 2000;

              this.$emit('exchanges', this.exchanges);

              this.$emit('pair', data.pair, true);

              this.$emit('alert', {
                id: `server_status`,
                type: 'info',
                title: `Tracking ${data.pair}`,
                message: !this.exchanges.length ? 'No connected exchanges' : 'On ' + this.exchanges.join(', ').toUpperCase()
              });

              let dismissed = localStorage.getItem('inaccurate_clock_dismissed') || 0;
            break;
            case 'pair':
              this.$emit('pair', data.pair);

              this.$emit('alert', {
                id: `pair`,
                type: 'info',
                title: `Now tracking ${data.pair}`,
              });
            break;
            case 'exchange_connected':
              if (options.debug) {
                this.$emit('alert', {
                  data: {
                    type: 'connected',
                    exchange: data.id,
                  },
                  id: `${data.id}_status`,
                  type: 'success',
                  message: `[${data.id}] connected`
                });
              }

              if (this.exchanges.indexOf(data.id) === -1)
                this.exchanges.push(data.id);

              this.$emit('exchanges', this.exchanges);
            break;
            case 'exchange_disconnected':
              if (options.debug) {
                this.$emit('alert', {
                  data: {
                    type: 'disconnected',
                    exchange: data.id,
                  },
                  id: `${data.id}_status`,
                  type: 'error',
                  message: `[${data.id}] disconnected`
                });
              }

              if (this.exchanges.indexOf(data.id) !== -1)
                this.exchanges.splice(this.exchanges.indexOf(data.id), 1);

              this.$emit('exchanges', this.exchanges);
            break;
            case 'exchange_error':
              if (options.debug) {
                this.$emit('alert', {
                  type: 'error',
                  title: `[${data.id}] an error occured`,
                  id: `${data.id}_status`,
                  message: data.message
                });
              }
            break;
          }
        }
      }

      this.socket.onclose = () => {
        if (this.connected) {
          this.connected = false;

          this.$emit('alert', {
            type: 'error',
            message: `Connection lost`,
            id: `server_status`,
          });

          this.$emit('disconnected');

          clearInterval(this.refreshStatsInterval);
        }

        this.reconnect();
      }

      this.socket.onerror = err => {
        this.$emit('alert', {
          type: 'error',
          id: `server_status`,
          message: `Couldn't reach the server`,
        });

        this.$emit('error', err);

        this.reconnect();
      }
    },
    send(method, message) {
      if (this.socket && this.socket.readyState === 1) {
        this.socket.send(JSON.stringify({
          method: method,
          message: message
        }))
      }
    },
    disconnect() {
      this.socket && this.socket.close();
    },
    reconnect() {
      if (this.socket && this.socket.readyState === 1) {
        return;
      }

      clearTimeout(this.reconnectionTimeout);

      this.reconnectionTimeout = setTimeout(this.connect.bind(this), this.reconnectionDelay);

      this.reconnectionDelay *= 1.1;
    },
    fetch(from, to = null, willReplace = false) {
      if (!to) {
        to = +new Date();
        from = to - from * 1000 * 60;
        willReplace = true;
      }

      const url = `${this.http_url}/history/${parseInt(from)}/${parseInt(to)}`;

      if (this.lastFetchUrl === url) {
        return new Promise((resolve, reject) => resolve());
      }

      this.lastFetchUrl = url;

      return new Promise((resolve, reject) => {
        Axios.get(url, {
          onDownloadProgress: e => this.$emit('fetchProgress', {
            loaded: e.loaded,
            total: e.total,
            progress: e.loaded / e.total
          })
        })
        .then(response => {
          const trades = response.data;
          const count = this.trades.length;

          if (this.delayed) {
            for (let i=0; i<trades.length; i++) {
              trades[i][1] -= this.delay;
            }
          }

          if (willReplace || !this.trades || !this.trades.length) {
            this.trades = trades;
          } else {
            const prepend = trades.filter(trade => trade[1] <= this.trades[0][1]);
            const append = trades.filter(trade => trade[1] >= this.trades[this.trades.length - 1][1]);

            if (prepend.length) {
              this.trades = prepend.concat(this.trades);
            }

            if (append.length) {
              this.trades = this.trades.concat(append);
            }
          }

          if (count !== this.trades.length) {
            this.$emit('history', willReplace);
          }

          resolve(trades);
        })
        .catch(err => {
          err && this.$emit('alert', {
            type: 'error',
            title: `Unable to retrieve history`,
            message: err.message,
            id: `fetch_error`
          });

          reject(err);
        })
      });
    },
    trim(timestamp) {
      let index;

      for (index = this.trades.length - 1; index >= 0; index--) {
        if (this.trades[index][1] < timestamp) {
          break;
        }
      }

      if (index < 0) {
        return;
      }

      this.trades.splice(0, ++index);

      this.$emit('trim', timestamp);
    }
  }
});

export default emitter;