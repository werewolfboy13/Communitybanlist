import { steam } from 'scbl-lib/apis';
import { sequelize } from 'scbl-lib/db';
import { ExportBan, ExportBanList, SteamUser } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';
import { createDiscordWebhookMessage, Logger } from 'scbl-lib/utils';
import { HOST } from 'scbl-lib/config';

const UPDATE_STEAM_USER_INFO_REFRESH_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const UPDATE_STEAM_USER_INFO_BATCH_SIZE = 10;
const UPDATE_STEAM_USER_INFO_BATCH_TIMEOUT = 300000;
const UPDATE_STEAM_USER_INFO_BATCH_RETRIES = 3;

const DISCORD_ALERT_CAP = 50;

async function withTimeout(promise) {
  const myError = new Error(`timeout`);
  Error.captureStackTrace(myError);
  const timeout = new Promise(function timeoutClosure1(resolve, reject) {
    setTimeout(
      function timeoutClosure2() {
        reject(myError);
      }.bind(null, myError),
      UPDATE_STEAM_USER_INFO_BATCH_TIMEOUT
    );
  });

  return Promise.race([promise, timeout]);
}

export default class Core {
  static async updateSteamUserInfo() {
    Logger.verbose('Core', 1, 'Fetching Steam users to update...');
    const profileStartTime = Date.now();
    const users = await SteamUser.findAll({
      attributes: ['id'],
      where: {
        [Op.or]: [
          { lastRefreshedInfo: null },
          {
            lastRefreshedInfo: {
              [Op.lt]: new Date(new Date() - UPDATE_STEAM_USER_INFO_REFRESH_INTERVAL)
            }
          }
        ]
      }
    });

    Logger.verbose('Core', 1, `Updating ${users.length} Steam users...`);
    while (users.length > 0) {
      const batch = users.splice(0, Math.min(UPDATE_STEAM_USER_INFO_BATCH_SIZE, users.length));

      Logger.verbose(
        'Core',
        1,
        `Updating batch of ${batch.length} Steam users (${users.length} remaining)...`
      );
      let data = null;
      let numAttempts = 0;
      while (!data && numAttempts < UPDATE_STEAM_USER_INFO_BATCH_RETRIES) {
        try {
          const myData = await withTimeout(
            await steam('get', 'ISteamUser/GetPlayerSummaries/v0002', {
              steamids: batch.map((user) => user.id).join(',')
            })
          );
          data = myData.data;
          numAttempts = 50;
          Logger.verbose('Core', 1, `DEBUG: ${JSON.stringify(myData)}`);
        } catch (err) {
          if (err.message === 'timeout') {
            Logger.verbose(
              'Core',
              1,
              `Failed to update batch of ${batch.length} Steam users. Retrying : `,
              err
            );
            numAttempts++;
            continue;
          } else {
            Logger.verbose(
              'Core',
              1,
              `Failed to update batch of ${batch.length} Steam users: ${batch
                .map((user) => user.id)
                .join(',')} HTTP Response : ${err.response?.status}`,
              err
            );
            if (err.response?.status === 429) {
              throw err;
            }
          }
        }
      }

      for (const user of data?.response?.players) {
        try {
          await withTimeout(
            await SteamUser.update(
              {
                name: user.personaname,
                profileURL: user.profileurl,
                avatar: user.avatar,
                avatarMedium: user.avatarmedium,
                avatarFull: user.avatarfull,
                lastRefreshedInfo: Date.now()
              },
              { where: { id: user.steamid } }
            )
          );
        } catch (err) {
          Logger.verbose('Core', 1, `Failed to update Steam user: `, err);
          continue;
        }
      }
    }

    Logger.verbose(
      'Core',
      1,
      `Finished updating Steam users. Took ${((Date.now() - profileStartTime) / 1000).toFixed(2)}s`
    );
  }

  static async updateReputationPoints() {
    Logger.verbose('Core', 1, 'Updating reputation points of outdated Steam users...');
    const profileStartTime = Date.now();
    await sequelize.query(
      `
        UPDATE SteamUsers SU
        LEFT JOIN (
          SELECT
            PPBL.steamUser,
            SUM(PPBL.points) AS "points"
          FROM (
            SELECT 
              B.steamUser,
              IF(
                SUM(
                  IF(
                    B.expires IS NULL OR B.expires >= NOW(),
                    1,
                    0
                  )
                ) > 0,
                3,
                0
              ) +
              SUM(
                IF(
                  B.expires IS NULL OR B.expires >= NOW(),
                  0,
                  1
                )
              ) AS "points"
            FROM Bans B
            GROUP BY B.banList, B.steamUser
          ) PPBL
          GROUP BY PPBL.steamUser
        ) PPBLC ON SU.id = PPBLC.steamUser
        LEFT JOIN (
          SELECT
            PPBL.steamUser,
            SUM(PPBL.points) AS "points"
          FROM (
            SELECT 
              B.steamUser,
              IF(
                SUM(
                  IF(
                    B.expires IS NULL OR B.expires >= NOW() - INTERVAL 1 MONTH,
                    1,
                    0
                  )
                ) > 0,
                3,
                0
              ) +
              SUM(
                IF(
                  B.expires IS NULL OR B.expires >= NOW() - INTERVAL 1 MONTH,
                  0,
                  1
                )
              ) AS "points"
            FROM Bans B
            WHERE B.created < NOW() - INTERVAL 1 MONTH
            GROUP BY B.banList, B.steamUser
          ) PPBL
          GROUP BY PPBL.steamUser
        ) PPBLMB ON SU.id = PPBLMB.steamUser
        SET
          SU.reputationPoints = IFNULL(PPBLC.points, 0),
          SU.reputationPointsMonthBefore = IFNULL(PPBLMB.points, 0),
          SU.reputationPointsMonthChange = IFNULL(PPBLC.points, 0) - IFNULL(PPBLMB.points, 0),
          SU.lastRefreshedReputationPoints = NOW()
        WHERE SU.lastRefreshedReputationPoints IS NULL
      `
    );
    Logger.verbose(
      'Core',
      1,
      `Finished Updating reputation points of outdated Steam users. Took ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s`
    );
  }

  static async updateReputationRank() {
    Logger.verbose('Core', 1, 'Updating reputation rank of Steam users...');
    const profileStartTime = Date.now();
    await sequelize.query(`
    SET @Dt = NOW();
    `);

    //Leave this at RANK() because that way we can actually count how many ppl were on ranks before this one.
    //DENSE_RANK() fucks counting up when browsing ranks
    await sequelize.query(
      `  
      CREATE TEMPORARY TABLE Temp_RankedSteamUsers
        SELECT id, RANK() OVER (ORDER BY reputationPoints DESC) AS reputationRank
      FROM SteamUsers;
      `
    );
    await sequelize.query(
      `
      UPDATE SteamUsers su
      JOIN Temp_RankedSteamUsers rr ON su.id = rr.id
      SET su.reputationRank = rr.reputationRank,
          su.lastRefreshedReputationRank = @Dt;
      `
    );
    Logger.verbose(
      'Core',
      1,
      `Finished Updating reputation rank of Steam users. Took ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s`
    );
  }

  static async exportExportBans() {
    Logger.verbose('Core', 1, 'Exporting Bans...');
    const profileStartTime = Date.now();
    // Get bans that need exporting.
    const exportBans = await ExportBan.findAll({
      where: { status: { [Op.in]: ['TO_BE_CREATED', 'TO_BE_DELETED'] } },
      include: [ExportBanList, SteamUser]
    });
    Logger.verbose(
      'Core',
      1,
      `Step Done: Getting Bans that need exporting after ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s`
    );

    // Tally the number of changes per ban list.
    const listChangeCount = {};
    for (const exportBan of exportBans) {
      if (exportBan.ExportBanList.id in listChangeCount)
        listChangeCount[exportBan.ExportBanList.id].count++;
      else
        listChangeCount[exportBan.ExportBanList.id] = {
          exportBanList: exportBan.ExportBanList,
          count: 1
        };
    }
    Logger.verbose(
      'Core',
      1,
      `Step Done: Tallying number of Bans after ${((Date.now() - profileStartTime) / 1000).toFixed(
        2
      )}s`
    );

    // Mark whether to do Discord alerts for each ban.
    for (const exportBan of exportBans)
      exportBan.doDiscordAlert =
        listChangeCount[exportBan.ExportBanList.id].count < DISCORD_ALERT_CAP;
    Logger.verbose(
      'Core',
      1,
      `Step Done: Marking Bans for discord alerts after ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s`
    );

    // Update the export bans.
    for (const exportBan of exportBans) {
      Logger.verbose(
        'Core',
        1,
        `${exportBan.status === 'TO_BE_CREATED' ? 'Creat' : 'Delet'}ing export ban (ID: ${
          exportBan.id
        })...`
      );

      try {
        if (exportBan.status === 'TO_BE_CREATED') await Core.createExportBan(exportBan);
        else await Core.deleteExportBan(exportBan);
      } catch (err) {
        Logger.verbose(
          'Core',
          1,
          `Failed to ${
            exportBan.status === 'TO_BE_CREATED' ? 'create' : 'delete'
          } export ban (ID: ${exportBan.id}): `,
          err
        );
      }
    }
    Logger.verbose(
      'Core',
      1,
      `Step Done: Updating export Bans after ${((Date.now() - profileStartTime) / 1000).toFixed(
        2
      )}s`
    );

    // Do Discord alerts for ban lists exceeding the threshold.
    for (const { exportBanList, count } of Object.values(listChangeCount)) {
      if (!exportBanList.discordWebhook || count < DISCORD_ALERT_CAP) continue;

      const [hook, message] = createDiscordWebhookMessage(exportBanList.discordWebhook);

      message.setTitle("We've updated your export ban list.");
      message.setDescription(
        `We've made some changes to who's on your export ban list named "${exportBanList.name}".\n Sadly, there's too many changes for us to document them individually.`
      );

      // Catch broken webhooks.
      try {
        await hook.send(message);
      } catch (err) {
        Logger.verbose('Core', 1, `Failed to send Discord Webhook: ${exportBanList.name}`, err);
      }
    }
    Logger.verbose(
      'Core',
      1,
      `Finished Exporting Bans. Took ${((Date.now() - profileStartTime) / 1000).toFixed(2)}s`
    );
  }

  static async createExportBan(exportBan) {
    // Add to external export sources.
    if (exportBan.ExportBanList.type === 'battlemetrics') await exportBan.createBattlemetricsBan();

    // Update the record to indicate it has been created.
    exportBan.status = 'CREATED';
    await exportBan.save();

    // Send Discord alert.
    if (!exportBan.ExportBanList.discordWebhook || !exportBan.doDiscordAlert) return;

    const [hook, message] = createDiscordWebhookMessage(exportBan.ExportBanList.discordWebhook, {
      color: '#00ff00'
    });

    message.setTitle(`${exportBan.SteamUser.name} has been added to your export ban list.`);
    message.setDescription(
      `[${exportBan.SteamUser.name}](${HOST}/search/${exportBan.SteamUser.id}) has reached the threshold required to be added to your export ban list named "${exportBan.ExportBanList.name}".`
    );
    message.setThumbnail(exportBan.SteamUser.avatarMedium);

    // Catch broken webhooks.
    try {
      await hook.send(message);
    } catch (err) {
      Logger.verbose(
        'Core',
        1,
        `Failed to send Discord Webhook. See logs above to see which webhook to take action on.`,
        err
      );
    }
  }

  static async deleteExportBan(exportBan) {
    // Delete from external export sources.
    if (exportBan.ExportBanList.type === 'battlemetrics') await exportBan.deleteBattlemetricsBan();

    // Delete the record.
    await exportBan.destroy();

    // Send Discord alert.
    if (!exportBan.ExportBanList.discordWebhook || !exportBan.doDiscordAlert) return;

    const [hook, message] = createDiscordWebhookMessage(exportBan.ExportBanList.discordWebhook, {
      color: '#ff0000'
    });

    message.setTitle(`${exportBan.SteamUser.name} has been removed from your export ban list.`);
    message.setDescription(
      `[${exportBan.SteamUser.name}](${HOST}/search/${exportBan.SteamUser.id}) no longer meets the threshold required to be on your export ban list named "${exportBan.ExportBanList.name}" so has been removed.`
    );
    message.setThumbnail(exportBan.SteamUser.avatarMedium);

    // Catch broken webhooks.
    try {
      await hook.send(message);
    } catch (err) {
      Logger.verbose(
        'Core',
        1,
        `Failed to send Discord Webhook. See logs above to see which webhook to take action on.`,
        err
      );
    }
  }

  //https://stackoverflow.com/a/68396354
  // Implements promise.race
  static async race(promises) {
    // Create a promise that resolves as soon as
    // any of the promises passed in resolve or reject.
    const raceResultPromise = new Promise((resolve, reject) => {
      // Keep track of whether we've heard back from any promise yet.
      let resolved = false;

      // Protect the resolve call so that only the first
      // promise can resolve the race.
      const resolver = (promisedVal) => {
        if (resolved) {
          return;
        }
        resolved = true;

        resolve(promisedVal);
      };

      // Protect the rejects too because they can end the race.
      const rejector = (promisedErr) => {
        if (resolved) {
          return;
        }
        resolved = true;

        reject(promisedErr);
      };

      // Place the promises in the race, each can
      // call the resolver, but the resolver only
      // allows the first to win.
      promises.forEach(async (promise) => {
        try {
          const promisedVal = await promise;
          resolver(promisedVal);
        } catch (e) {
          rejector(e);
        }
      });
    });

    return raceResultPromise;
  }
}
