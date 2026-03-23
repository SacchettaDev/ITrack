namespace ITrack.api.Dtos;

public class JobListingDto
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Company { get; set; } = "";
    public string Location { get; set; } = "";
    public string Area { get; set; } = "";
    public List<string> Technologies { get; set; } = new();
    public string Source { get; set; } = "";
    public string Url { get; set; } = "";
    public string PostedDate { get; set; } = "";
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }
    public string GeoPrecision { get; set; } = "none";
}

