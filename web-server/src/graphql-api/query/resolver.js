import { Organization, Ban, BanList, SteamUser } from 'database/models';

export default {
  Query: {
    organizations: async () => {
      return Organization.find().sort({ name: 1 });
    },

    organizationCount: async () => {
      return Organization.countDocuments();
    },

    banLists: async () => {
      return BanList.find();
    },

    banListCount: async () => {
      return BanList.countDocuments();
    },

    banCount: async () => {
      return Ban.countDocuments();
    },

    uniqueBannedSteamIDCount: async () => {
      return (await Ban.distinct('steamID')).length;
    },

    playerBans: async(parent, filter) => {
      let query = {
        steamID: filter.steamID
      };

      if ('expired' in filter) query.expired = filter.expired;

      return Ban.find(query);
    },

    currentSteamUser: async (parent, _, context) => {
      return SteamUser.findOne({ steamID: context.user });
    }
  }
};
